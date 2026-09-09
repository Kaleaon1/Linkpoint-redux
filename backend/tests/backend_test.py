"""GridLink backend regression tests."""
import os
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "https://avatar-messenger-7.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def offline_session(client):
    r = client.post(f"{API}/login/offline", json={"avatar_name": "TEST_Tester Resident"}, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    yield data
    client.post(f"{API}/logout", params={"session_id": data["session_id"]}, timeout=15)


# --- root / grids
class TestRoot:
    def test_root(self, client):
        r = client.get(f"{API}/", timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d.get("app") == "GridLink"
        assert "agni" in d.get("grids", [])


# --- offline login + seeding
class TestOfflineLogin:
    def test_offline_login_shape(self, offline_session):
        assert offline_session["ok"] is True
        assert offline_session["mode"] == "offline"
        assert offline_session["friends_count"] >= 1
        assert offline_session["inventory_folders"] >= 5

    def test_session_get(self, client, offline_session):
        r = client.get(f"{API}/session", params={"session_id": offline_session["session_id"]}, timeout=15)
        assert r.status_code == 200
        assert r.json()["avatar_name"] == "TEST_Tester Resident"

    def test_friends_seeded(self, client, offline_session):
        r = client.get(f"{API}/friends", params={"session_id": offline_session["session_id"]}, timeout=15)
        assert r.status_code == 200
        friends = r.json()
        assert len(friends) >= 5
        assert all("name" in f and "online" in f for f in friends)

    def test_inventory_seeded(self, client, offline_session):
        r = client.get(f"{API}/inventory", params={"session_id": offline_session["session_id"]}, timeout=15)
        assert r.status_code == 200
        inv = r.json()
        assert len(inv) >= 10
        names = [i["name"] for i in inv]
        assert "My Inventory" in names


# --- chat
class TestChat:
    def test_send_and_fetch_local(self, client, offline_session):
        sid = offline_session["session_id"]
        r = client.post(f"{API}/chat/send", json={
            "session_id": sid, "channel": "local", "scope": "local", "text": "hello world"
        }, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json()["text"] == "hello world"
        # verify persistence + offline echo
        g = client.get(f"{API}/chat", params={"session_id": sid, "channel": "local", "scope": "local"}, timeout=15)
        assert g.status_code == 200
        msgs = g.json()
        assert any(m["text"] == "hello world" for m in msgs)
        assert any(m.get("system") for m in msgs)

    def test_send_im(self, client, offline_session):
        sid = offline_session["session_id"]
        r = client.post(f"{API}/chat/send", json={
            "session_id": sid, "channel": "im", "scope": "Ruth Resident", "text": "hi ruth"
        }, timeout=15)
        assert r.status_code == 200
        g = client.get(f"{API}/chat", params={"session_id": sid, "channel": "im", "scope": "Ruth Resident"}, timeout=15)
        assert any(m["text"] == "hi ruth" for m in g.json())

    def test_send_group(self, client, offline_session):
        sid = offline_session["session_id"]
        r = client.post(f"{API}/chat/send", json={
            "session_id": sid, "channel": "group", "scope": "Builders", "text": "gm"
        }, timeout=15)
        assert r.status_code == 200

    def test_send_invalid_session(self, client):
        r = client.post(f"{API}/chat/send", json={
            "session_id": "does-not-exist", "channel": "local", "scope": "local", "text": "x"
        }, timeout=15)
        assert r.status_code == 404


# --- grid login (fake creds must reach the grid)
class TestGridLogin:
    def test_grid_login_fake_creds(self, client):
        r = client.post(f"{API}/login/grid", json={
            "first": "Test", "last": "Resident", "password": "invalid",
            "grid": "agni", "start": "last", "agree_to_tos": True
        }, timeout=45)
        # 401 = grid reached and rejected creds (SUCCESS). 502 = network unreachable.
        assert r.status_code in (401, 502), f"Unexpected: {r.status_code} {r.text}"
        if r.status_code == 401:
            body = r.json()
            detail = body.get("detail", {})
            assert isinstance(detail, dict)
            assert "message" in detail or "reason" in detail


# --- diagnostics
class TestDiagnostics:
    def test_diagnostics_agni(self, client):
        r = client.get(f"{API}/diagnostics", params={"grid": "agni"}, timeout=60)
        assert r.status_code == 200
        d = r.json()
        assert d["grid"] == "agni"
        assert d["login_uri"].startswith("https://login.agni.lindenlab.com")
        assert d["dns_ok"] is True
        assert d["reachable"] is True
        assert d["latency_ms"] is not None
        assert d["viewer_channel"] == "GridLink Mobile"

    def test_diagnostics_bad_grid(self, client):
        r = client.get(f"{API}/diagnostics", params={"grid": "nope"}, timeout=15)
        assert r.status_code == 400


# --- logout
class TestLogout:
    def test_logout_clears(self, client):
        # create fresh
        r = client.post(f"{API}/login/offline", json={"avatar_name": "TEST_Byebye"}, timeout=15)
        sid = r.json()["session_id"]
        r = client.post(f"{API}/logout", params={"session_id": sid}, timeout=15)
        assert r.status_code == 200
        # session gone
        r = client.get(f"{API}/session", params={"session_id": sid}, timeout=15)
        assert r.status_code == 404
