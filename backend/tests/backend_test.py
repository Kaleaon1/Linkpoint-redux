"""GridLink backend regression tests (iteration 2).

Covers new features: groups per-session, IM conversations, resident search,
friend requests (offline), presence status, grid circuit login (real account).
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

# Real Second Life credentials from /app/memory/test_credentials.md
GRID_FIRST = "Kaleaon"
GRID_LAST = "Resident"
GRID_PASSWORD = "SealofRassilon02"
GRID = "agni"


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


# --- root
class TestRoot:
    def test_root(self, client):
        r = client.get(f"{API}/", timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d.get("app") == "GridLink"
        assert "agni" in d.get("grids", [])


# --- offline: login + seeding + status
class TestOfflineBasics:
    def test_offline_login_shape(self, offline_session):
        assert offline_session["ok"] is True
        assert offline_session["mode"] == "offline"
        assert offline_session["friends_count"] >= 5
        assert offline_session["inventory_folders"] >= 5

    def test_status_offline(self, client, offline_session):
        r = client.get(f"{API}/status", params={"session_id": offline_session["session_id"]}, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d["mode"] == "offline"
        assert d["connected"] is True

    def test_friends_seeded_and_sorted(self, client, offline_session):
        r = client.get(f"{API}/friends", params={"session_id": offline_session["session_id"]}, timeout=15)
        assert r.status_code == 200
        friends = r.json()
        # module-scoped fixture: >=5 because friend-request test may have added one
        assert len(friends) >= 5
        # Online-first sort
        online_flags = [f["online"] for f in friends]
        # All online come before all offline (True>False so descending)
        assert online_flags == sorted(online_flags, reverse=True), f"not sorted online-first: {online_flags}"

    def test_groups_seeded(self, client, offline_session):
        r = client.get(f"{API}/groups", params={"session_id": offline_session["session_id"]}, timeout=15)
        assert r.status_code == 200
        groups = r.json()
        assert len(groups) == 3
        names = {g["name"] for g in groups}
        assert names == {"The Sandbox", "Firestorm Support", "Builders Guild"}


# --- offline: IM conversations, search, friend request
class TestOfflineNewFeatures:
    def test_im_conversations_start_empty(self, client, offline_session):
        r = client.get(f"{API}/im/conversations", params={"session_id": offline_session["session_id"]}, timeout=15)
        assert r.status_code == 200
        assert r.json() == []

    def test_send_im_creates_conversation(self, client, offline_session):
        sid = offline_session["session_id"]
        # Pick first friend (has uuid-like id)
        friends = client.get(f"{API}/friends", params={"session_id": sid}, timeout=15).json()
        peer = friends[0]
        r = client.post(f"{API}/chat/send", json={
            "session_id": sid, "channel": "im", "scope": peer["id"], "scope_name": peer["name"], "text": "hey buddy",
        }, timeout=15)
        assert r.status_code == 200, r.text
        # Conversation should list this peer
        conv = client.get(f"{API}/im/conversations", params={"session_id": sid}, timeout=15).json()
        assert any(c["id"] == peer["id"] and c["name"] == peer["name"] for c in conv)

    def test_search_residents_offline(self, client, offline_session):
        sid = offline_session["session_id"]
        r = client.get(f"{API}/search/residents", params={"session_id": sid, "q": "lind"}, timeout=15)
        assert r.status_code == 200
        hits = r.json()
        assert len(hits) >= 3
        names = {h["name"] for h in hits}
        # Some Linden names should appear
        assert any("Linden" in n for n in names)
        # is_friend flag - Torley Linden is a seeded friend
        torley = next((h for h in hits if h["name"] == "Torley Linden"), None)
        assert torley is not None
        assert torley["is_friend"] is True
        # Governor Linden also seeded friend
        gov = next((h for h in hits if h["name"] == "Governor Linden"), None)
        assert gov is not None and gov["is_friend"] is True

    def test_search_residents_too_short(self, client, offline_session):
        r = client.get(f"{API}/search/residents", params={"session_id": offline_session["session_id"], "q": "a"}, timeout=15)
        assert r.status_code == 200
        assert r.json() == []

    def test_friend_request_offline_upsert(self, client, offline_session):
        sid = offline_session["session_id"]
        before = len(client.get(f"{API}/friends", params={"session_id": sid}, timeout=15).json())
        new_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        r = client.post(f"{API}/friends/request", json={
            "session_id": sid, "agent_id": new_id, "name": "TEST_NewFriend Resident", "message": "hi",
        }, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert body.get("delivered") == "offline"
        after = client.get(f"{API}/friends", params={"session_id": sid}, timeout=15).json()
        assert len(after) == before + 1
        assert any(f["id"] == new_id for f in after)


# --- logout cleans groups too
class TestLogoutCleansGroups:
    def test_logout_removes_groups(self, client):
        r = client.post(f"{API}/login/offline", json={"avatar_name": "TEST_Cleaner"}, timeout=15)
        sid = r.json()["session_id"]
        assert len(client.get(f"{API}/groups", params={"session_id": sid}, timeout=15).json()) == 3
        r2 = client.post(f"{API}/logout", params={"session_id": sid}, timeout=15)
        assert r2.status_code == 200
        # After logout groups should be gone (session gone too)
        g = client.get(f"{API}/groups", params={"session_id": sid}, timeout=15)
        assert g.status_code == 200
        assert g.json() == []


# --- Regression: local chat still echoes
class TestLocalChatEcho:
    def test_local_send_and_echo(self, client, offline_session):
        sid = offline_session["session_id"]
        r = client.post(f"{API}/chat/send", json={
            "session_id": sid, "channel": "local", "scope": "local", "text": "hello world regression",
        }, timeout=15)
        assert r.status_code == 200
        msgs = client.get(f"{API}/chat", params={"session_id": sid, "channel": "local", "scope": "local"}, timeout=15).json()
        assert any(m["text"] == "hello world regression" for m in msgs)
        assert any(m.get("system") for m in msgs)


# --- Grid mode: REAL account. Run ONCE, then logout. Do NOT parallelize.
class TestGridLive:
    """Real Second Life circuit test. Marked serial via module fixtures.

    NOTE: SL allows one live circuit per avatar. This test suite must not
    run more than once concurrently. Never send friend requests here.
    """

    @pytest.fixture(scope="class")
    def grid_session(self, client):
        # Wait for any previous circuit to close
        time.sleep(3)
        r = client.post(f"{API}/login/grid", json={
            "first": GRID_FIRST, "last": GRID_LAST, "password": GRID_PASSWORD,
            "grid": GRID, "start": "last", "agree_to_tos": True,
        }, timeout=60)
        if r.status_code != 200:
            pytest.skip(f"grid login unavailable: {r.status_code} {r.text[:200]}")
        data = r.json()
        yield data
        # Cleanup - critical
        try:
            client.post(f"{API}/logout", params={"session_id": data["session_id"]}, timeout=15)
        except Exception:
            pass
        time.sleep(2)

    def test_login_response(self, grid_session):
        assert grid_session["ok"] is True
        assert grid_session["mode"] == "grid"
        assert grid_session["agent_id"]
        assert grid_session["sim_ip"]
        assert grid_session["sim_port"]

    def test_circuit_connects(self, client, grid_session):
        sid = grid_session["session_id"]
        # Poll status up to ~10s waiting for connected+region_name
        connected = False
        region_name = None
        for _ in range(10):
            time.sleep(1)
            st = client.get(f"{API}/status", params={"session_id": sid}, timeout=15).json()
            if st.get("connected") and st.get("region_name"):
                connected = True
                region_name = st["region_name"]
                break
        assert connected, f"circuit did not connect in 10s (last status: {st})"
        assert region_name

    def test_friends_are_real(self, client, grid_session):
        sid = grid_session["session_id"]
        friends = client.get(f"{API}/friends", params={"session_id": sid}, timeout=30).json()
        assert len(friends) > 100, f"only {len(friends)} friends"
        # Real names, not placeholders
        placeholder_count = sum(1 for f in friends if f["name"].startswith("Resident ") and len(f["name"].split()) == 2 and len(f["name"].split()[1]) == 8)
        assert placeholder_count < len(friends) * 0.5, f"{placeholder_count}/{len(friends)} still placeholders"

    def test_groups_are_real(self, client, grid_session):
        sid = grid_session["session_id"]
        # Wait a bit more for group list to arrive over the circuit
        time.sleep(4)
        groups = client.get(f"{API}/groups", params={"session_id": sid}, timeout=30).json()
        assert len(groups) > 0, "no groups returned"
        # Should be real names, not the offline mock set
        offline_names = {"The Sandbox", "Firestorm Support", "Builders Guild"}
        real_names = {g["name"] for g in groups} - offline_names
        assert len(real_names) > 0, f"only offline mock groups returned: {groups}"

    def test_search_torley_linden(self, client, grid_session):
        sid = grid_session["session_id"]
        r = client.get(f"{API}/search/residents", params={"session_id": sid, "q": "Torley Linden"}, timeout=20)
        assert r.status_code == 200, r.text
        hits = r.json()
        assert any("Torley" in h["name"] for h in hits), f"no Torley in {[h['name'] for h in hits]}"

    def test_local_chat_send(self, client, grid_session):
        sid = grid_session["session_id"]
        r = client.post(f"{API}/chat/send", json={
            "session_id": sid, "channel": "local", "scope": "local", "text": "GridLink automated test",
        }, timeout=20)
        assert r.status_code == 200, r.text
