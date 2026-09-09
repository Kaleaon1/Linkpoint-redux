"""
GridLink backend: Second Life communicator API.

Uses the same login handshake as the Firestorm viewer / libremetaverse:
XML-RPC to https://login.agni.lindenlab.com/cgi-bin/login.cgi with a struct
containing first, last, passwd ("$1$" + md5(password[:16])), start, channel,
version, platform, mac (md5 hex), id0 (md5 hex), agree_to_tos, read_critical
and options[] naming the response elements we want back (buddy-list,
inventory-skeleton, gestures, etc.).

Full sim UDP messaging is not feasible in a mobile preview, so once logged in
we persist chat locally in Mongo scoped to the SL session; friends and
inventory come straight from the login response's buddy-list and
inventory-skeleton.  Offline mode lets the user pick an avatar name and use
the same UI against local mock data.
"""
from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import hashlib
import math
import socket
import time
import uuid
import asyncio
import xmlrpc.client
from pathlib import Path
from datetime import datetime, timezone
from typing import List, Optional, Literal, Dict, Any
from pydantic import BaseModel, Field
import requests
from pymongo import MongoClient
from urllib.parse import quote

import llsd
from sl_circuit import Circuit, CIRCUITS

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]
# Sync handle for the UDP circuit threads (they can't use the async driver).
sync_db = MongoClient(mongo_url)[os.environ["DB_NAME"]]

app = FastAPI(title="GridLink SL Communicator")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("gridlink")

# ---------------------------------------------------------------------------
# Grid endpoints (Agni = main SL grid, Aditi = beta grid)
# ---------------------------------------------------------------------------
GRIDS = {
    "agni": {
        "name": "Second Life (Agni)",
        "login_uri": "https://login.agni.lindenlab.com/cgi-bin/login.cgi",
    },
    "aditi": {
        "name": "Second Life Beta (Aditi)",
        "login_uri": "https://login.aditi.lindenlab.com/cgi-bin/login.cgi",
    },
}

VIEWER_CHANNEL = "GridLink Mobile"
VIEWER_VERSION = "1.0.0.0"
VIEWER_PLATFORM = "Lin"


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class LoginRequest(BaseModel):
    first: str
    last: str = "Resident"
    password: str
    grid: Literal["agni", "aditi"] = "agni"
    start: str = "last"  # last | home | uri:REGION&x&y&z
    agree_to_tos: bool = True


class OfflineLoginRequest(BaseModel):
    avatar_name: str


class LoginResponse(BaseModel):
    ok: bool
    session_id: str
    mode: Literal["grid", "offline"]
    grid: str
    avatar_name: str
    agent_id: Optional[str] = None
    sl_session_id: Optional[str] = None
    sim_ip: Optional[str] = None
    sim_port: Optional[int] = None
    region: Optional[str] = None
    look_at: Optional[str] = None
    seed_capability: Optional[str] = None
    login_message: Optional[str] = None
    friends_count: int = 0
    inventory_folders: int = 0


class ChatMessage(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str
    channel: Literal["local", "im", "group"]
    scope: str  # "local" | im peer agent id | group id
    scope_name: Optional[str] = None
    sender: str
    sender_id: Optional[str] = None
    text: str
    ts: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    system: bool = False


class SendMessageRequest(BaseModel):
    session_id: str
    channel: Literal["local", "im", "group"]
    scope: str
    scope_name: Optional[str] = None
    text: str


class Group(BaseModel):
    id: str
    name: str
    insignia_id: Optional[str] = None
    accept_notices: bool = True


class Conversation(BaseModel):
    id: str
    name: str
    last_ts: str
    last_text: str


class SearchResult(BaseModel):
    id: str
    name: str
    username: str
    is_friend: bool = False


class FriendRequest(BaseModel):
    session_id: str
    agent_id: str
    name: str = ""
    message: str = ""


class FriendRequestIn(BaseModel):
    id: str  # IM transaction id (needed for AcceptFriendship/DeclineFriendship)
    from_id: str
    from_name: str
    message: str = ""
    ts: str
    status: str = "pending"


class RadarAvatar(BaseModel):
    id: str
    name: str
    x: float
    y: float
    z: float
    distance: Optional[float] = None
    is_friend: bool = False


class RadarResponse(BaseModel):
    region_name: Optional[str]
    connected: bool
    my_position: Optional[List[float]]
    updated_ago_s: Optional[float]
    avatars: List[RadarAvatar]


class UnreadEntry(BaseModel):
    channel: str
    scope: str
    scope_name: Optional[str] = None
    count: int


class MarkReadRequest(BaseModel):
    session_id: str
    channel: str
    scope: str


class Friend(BaseModel):
    id: str
    name: str
    online: bool
    can_see_me_online: bool = True
    can_see_me_map: bool = False
    can_modify_my_objects: bool = False


class InventoryFolder(BaseModel):
    id: str
    parent_id: Optional[str]
    name: str
    type: str
    version: int = 1


class Diagnostics(BaseModel):
    grid: str
    login_uri: str
    dns_ok: bool
    dns_ms: float
    reachable: bool
    tls_ms: float
    latency_ms: Optional[float]
    server_time: Optional[str]
    viewer_channel: str
    viewer_version: str
    error: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _md5(s: str) -> str:
    return hashlib.md5(s.encode("utf-8")).hexdigest()


def _sl_password(password: str) -> str:
    """SL expects "$1$" + md5 of the first 16 chars of the plaintext."""
    return "$1$" + _md5(password[:16])


def _stable_hex(seed: str) -> str:
    """Deterministic 32-char hex for mac/id0 so we don't leak the real device."""
    return _md5(f"gridlink::{seed}")


def _clean(doc: Dict[str, Any]) -> Dict[str, Any]:
    doc.pop("_id", None)
    return doc


# ---------------------------------------------------------------------------
# SL Display Name resolution.
# The XML-RPC login response's `buddy-list` only carries UUIDs and rights
# flags - no names. Names come from the `GetDisplayNames` capability which
# lives behind the login's `seed_capability`. Flow (per libremetaverse /
# Firestorm):
#   1. POST an LLSD array of wanted cap names to seed_capability
#   2. Response is an LLSD map of cap_name -> cap_url; grab GetDisplayNames
#   3. GET `${GetDisplayNames}?ids=uuid&ids=uuid&...` (batches <= 40)
#   4. Response is an LLSD map with `agents` array containing username /
#      display_name / legacy_first_name / legacy_last_name
# ---------------------------------------------------------------------------
WANTED_CAPS = ["GetDisplayNames", "AvatarPickerSearch", "EventQueueGet", "ChatSessionRequest"]


def _fetch_caps(seed_cap: str, names: List[str]) -> Dict[str, str]:
    """POST an LLSD array of cap names to the seed cap; returns name -> url."""
    try:
        r = requests.post(
            seed_cap,
            data=llsd.dump(names),
            headers={"Content-Type": "application/llsd+xml"},
            timeout=10,
        )
        if r.status_code != 200:
            log.warning("seed cap returned %s", r.status_code)
            return {}
        doc = llsd.parse(r.text) or {}
        return {k: v for k, v in doc.items() if isinstance(v, str) and v.startswith("http")}
    except Exception as e:
        log.warning("failed to fetch caps: %s", e)
        return {}


def _fetch_display_name_cap(seed_cap: str) -> Optional[str]:
    return _fetch_caps(seed_cap, ["GetDisplayNames"]).get("GetDisplayNames")


def _agent_records(agents: Any) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    for a in agents or []:
        if not isinstance(a, dict) or not a.get("id"):
            continue
        out[str(a["id"]).lower()] = {
            "username": a.get("username") or "",
            "display_name": a.get("display_name") or "",
            "legacy_first_name": a.get("legacy_first_name") or "",
            "legacy_last_name": a.get("legacy_last_name") or "",
        }
    return out


def _resolve_names(display_name_cap: str, ids: List[str]) -> Dict[str, Dict[str, str]]:
    out: Dict[str, Dict[str, str]] = {}
    if not display_name_cap or not ids:
        return out
    for i in range(0, len(ids), 40):
        batch = ids[i : i + 40]
        try:
            sep = "&" if "?" in display_name_cap else "?"
            url = display_name_cap + sep + "&".join(f"ids={x}" for x in batch)
            r = requests.get(url, timeout=10)
            if r.status_code != 200:
                log.warning("GetDisplayNames returned %s", r.status_code)
                continue
            out.update(_agent_records((llsd.parse(r.text) or {}).get("agents")))
        except Exception as e:
            log.warning("name batch failed: %s", e)
    return out


def _search_residents(cap: str, query: str) -> List[Dict[str, str]]:
    """AvatarPickerSearch cap: GET ?page_size=N&names=<query>."""
    sep = "&" if "?" in cap else "?"
    r = requests.get(f"{cap}{sep}page_size=30&names={quote(query)}", timeout=10)
    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"AvatarPickerSearch returned {r.status_code}")
    recs = _agent_records((llsd.parse(r.text) or {}).get("agents"))
    return [{"id": k, "name": _pretty_name(v, k), "username": v["username"]} for k, v in recs.items()]


def _pretty_name(rec: Dict[str, str], uuid_fallback: str) -> str:
    display = (rec.get("display_name") or "").strip()
    lfirst = (rec.get("legacy_first_name") or "").strip()
    llast = (rec.get("legacy_last_name") or "").strip()
    legacy = (f"{lfirst} {llast}").strip()
    if display and legacy and display.lower() != legacy.lower():
        return f"{display} ({legacy})"
    if display:
        return display
    if legacy:
        return legacy
    username = (rec.get("username") or "").strip()
    if username:
        return username
    return f"Resident {uuid_fallback[:8]}"


def _xmlrpc_login(payload: Dict[str, Any], login_uri: str) -> Dict[str, Any]:
    """Call the SL login XML-RPC endpoint. Runs the sync call as-is; caller uses
    it from an async endpoint - the login is a single short round trip."""
    transport = xmlrpc.client.SafeTransport()
    with xmlrpc.client.ServerProxy(login_uri, transport=transport, allow_none=True) as proxy:
        return proxy.login_to_simulator(payload)


def _default_inventory(session_id: str) -> List[Dict[str, Any]]:
    root = str(uuid.uuid4())
    now = 1
    base = [
        {"id": root, "parent_id": None, "name": "My Inventory", "type": "root", "version": now},
    ]
    folders = ["Textures", "Objects", "Clothing", "Body Parts", "Scripts", "Notecards", "Landmarks", "Sounds", "Animations", "Gestures", "Trash"]
    for f in folders:
        base.append({"id": str(uuid.uuid4()), "parent_id": root, "name": f, "type": f.lower().replace(" ", "_"), "version": now})
    return base


def _default_friends() -> List[Dict[str, Any]]:
    seed = [
        ("Ruth Resident", True),
        ("Governor Linden", True),
        ("Torley Linden", False),
        ("Philip Linden", False),
        ("Magnum Resident", True),
    ]
    return [
        {"id": _md5(name), "name": name, "online": online,
         "can_see_me_online": True, "can_see_me_map": False, "can_modify_my_objects": False}
        for name, online in seed
    ]


def _default_groups() -> List[Dict[str, Any]]:
    return [
        {"id": _md5(f"group::{n}"), "name": n, "insignia_id": None, "accept_notices": True}
        for n in ["The Sandbox", "Firestorm Support", "Builders Guild"]
    ]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@api.get("/")
async def root():
    return {"app": "GridLink", "grids": list(GRIDS.keys())}


@api.get("/grids")
async def list_grids():
    return [{"key": k, **v} for k, v in GRIDS.items()]


@api.post("/login/offline", response_model=LoginResponse)
async def login_offline(req: OfflineLoginRequest):
    name = req.avatar_name.strip() or "Anon Resident"
    session_id = str(uuid.uuid4())
    friends = _default_friends()
    inventory = _default_inventory(session_id)

    session_doc = {
        "session_id": session_id,
        "mode": "offline",
        "grid": "offline",
        "avatar_name": name,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "sl_login_response": None,
    }
    await db.sessions.insert_one(dict(session_doc))
    await db.friends.insert_many([{**f, "session_id": session_id} for f in friends])
    await db.inventory.insert_many([{**i, "session_id": session_id} for i in inventory])
    await db.groups.insert_many([{**g, "session_id": session_id} for g in _default_groups()])
    await db.friend_requests.insert_one({
        "id": str(uuid.uuid4()), "session_id": session_id, "from_id": _md5("Oz Linden"), "from_name": "Oz Linden",
        "message": "Hey! Met you at the sandbox - add me?", "ts": datetime.now(timezone.utc).isoformat(), "status": "pending",
    })

    return LoginResponse(
        ok=True,
        session_id=session_id,
        mode="offline",
        grid="offline",
        avatar_name=name,
        friends_count=len(friends),
        inventory_folders=len(inventory),
        login_message="Offline demo session. Chat is local-only.",
    )


async def _grid_login(*, first: str, last: str, passwd_hash: str, grid: str, start: str,
                      agree_to_tos: bool, session_id: str) -> LoginResponse:
    """Shared by /login/grid and /reconnect: XML-RPC login, roster/inventory
    sync into Mongo under `session_id`, then open the sim circuit."""
    if grid not in GRIDS:
        raise HTTPException(status_code=400, detail="Unknown grid")
    login_uri = GRIDS[grid]["login_uri"]
    req = LoginRequest(first=first, last=last, password="", grid=grid, start=start, agree_to_tos=agree_to_tos)

    mac = _stable_hex(f"mac::{req.first}::{req.last}")
    id0 = _stable_hex(f"id0::{req.first}::{req.last}")

    payload = {
        "first": req.first,
        "last": req.last or "Resident",
        "passwd": passwd_hash,
        "start": req.start,
        "channel": VIEWER_CHANNEL,
        "version": VIEWER_VERSION,
        "platform": VIEWER_PLATFORM,
        "platform_string": "Linux",
        "platform_version": "1.0.0",
        "mac": mac,
        "id0": id0,
        "agree_to_tos": "true" if req.agree_to_tos else "false",
        "read_critical": "true",
        "viewer_digest": _md5(VIEWER_CHANNEL + VIEWER_VERSION),
        "address_size": 64,
        "extended_errors": "true",
        "host_id": "",
        "mfa_hash": "",
        "token": "",
        "options": [
            "inventory-root",
            "inventory-skeleton",
            "inventory-lib-root",
            "inventory-lib-owner",
            "inventory-skel-lib",
            "gestures",
            "event_categories",
            "event_notifications",
            "classified_categories",
            "buddy-list",
            "ui-config",
            "login-flags",
            "global-textures",
            "adult_compliant",
        ],
    }

    try:
        resp = _xmlrpc_login(payload, login_uri)
    except Exception as e:  # network / TLS / XML errors
        log.exception("SL login transport error")
        raise HTTPException(status_code=502, detail=f"Grid unreachable: {e}")

    if not resp or resp.get("login") != "true":
        reason = resp.get("reason") if isinstance(resp, dict) else "unknown"
        message = resp.get("message") if isinstance(resp, dict) else "Login failed"
        raise HTTPException(status_code=401, detail={"reason": reason, "message": message})

    # Parse response
    agent_id = resp.get("agent_id")
    sl_session = resp.get("session_id")
    first = resp.get("first_name", req.first).strip('"')
    last = resp.get("last_name", req.last).strip('"')
    avatar_name = f"{first} {last}".strip()
    sim_ip = resp.get("sim_ip")
    sim_port = resp.get("sim_port")
    region_x = resp.get("region_x")
    region_y = resp.get("region_y")
    look_at = resp.get("look_at")
    seed_cap = resp.get("seed_capability")
    login_msg = resp.get("message")
    circuit_code = resp.get("circuit_code")

    # Buddy list -> friends. Presence is NOT in the login response; it arrives
    # as OnlineNotification over the sim circuit once we're in world.
    buddies = resp.get("buddy-list") or []
    friends: List[Dict[str, Any]] = []
    for b in buddies:
        if not isinstance(b, dict):
            continue
        buddy_id = b.get("buddy_id") or str(uuid.uuid4())
        rights_given = int(b.get("buddy_rights_given", 0) or 0)
        friends.append({
            "id": buddy_id,
            "name": f"Resident {buddy_id[:8]}",
            "online": False,
            "can_see_me_online": bool(rights_given & 1),
            "can_see_me_map": bool(rights_given & 2),
            "can_modify_my_objects": bool(rights_given & 4),
        })

    # Capabilities: display names, resident search, event queue.
    caps: Dict[str, str] = {}
    if seed_cap:
        caps = await asyncio.to_thread(_fetch_caps, str(seed_cap), WANTED_CAPS)

    # Resolve display names via GetDisplayNames.
    cap_url = caps.get("GetDisplayNames")
    if cap_url and friends:
        try:
            ids = [f["id"] for f in friends]
            names = await asyncio.to_thread(_resolve_names, cap_url, ids)
            for f in friends:
                rec = names.get(f["id"].lower())
                if rec:
                    f["name"] = _pretty_name(rec, f["id"])
            # Refresh avatar_name from resolver too (display name > legacy)
            if agent_id:
                self_rec = names.get(str(agent_id).lower())
                if not self_rec:
                    extra = await asyncio.to_thread(_resolve_names, cap_url, [str(agent_id)])
                    self_rec = extra.get(str(agent_id).lower())
                if self_rec:
                    avatar_name = _pretty_name(self_rec, str(agent_id))
        except Exception as e:
            log.warning("display-name resolution skipped: %s", e)

    # Inventory skeleton -> folders
    skel = resp.get("inventory-skeleton") or []
    inv_root_id = None
    inv_root = resp.get("inventory-root")
    if isinstance(inv_root, list) and inv_root and isinstance(inv_root[0], dict):
        inv_root_id = inv_root[0].get("folder_id")
    inventory: List[Dict[str, Any]] = []
    for f in skel:
        if not isinstance(f, dict):
            continue
        inventory.append({
            "id": f.get("folder_id") or str(uuid.uuid4()),
            "parent_id": f.get("parent_id") if f.get("parent_id") != "00000000-0000-0000-0000-000000000000" else None,
            "name": f.get("name") or "Folder",
            "type": str(f.get("type_default", "folder")),
            "version": int(f.get("version", 1) or 1),
        })
    if not inventory:
        inventory = _default_inventory("grid")

    region = f"{region_x},{region_y}" if region_x is not None else None
    calling_cards = next((i["id"] for i in inventory if i["type"] == "2"), None)

    session_doc = {
        "session_id": session_id,
        "mode": "grid",
        "grid": req.grid,
        "avatar_name": avatar_name,
        "agent_id": agent_id,
        "sl_session_id": sl_session,
        "sim_ip": sim_ip,
        "sim_port": sim_port,
        "region": region,
        "look_at": str(look_at) if look_at is not None else None,
        "seed_capability": seed_cap,
        "caps": caps,
        "circuit_code": circuit_code,
        "calling_cards_folder": calling_cards,
        "region_name": None,
        # Kept so /reconnect can re-run the handshake (SL accepts the $1$md5 hash, never plaintext).
        "login_creds": {"first": req.first, "last": req.last, "passwd_hash": passwd_hash, "grid": grid, "start": start},
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    # Reconnect re-uses the session_id so chat history survives; refresh roster & inventory.
    await db.sessions.replace_one({"session_id": session_id}, session_doc, upsert=True)
    await db.friends.delete_many({"session_id": session_id})
    await db.inventory.delete_many({"session_id": session_id})
    if friends:
        await db.friends.insert_many([{**fr, "session_id": session_id} for fr in friends])
    await db.inventory.insert_many([{**it, "session_id": session_id} for it in inventory])

    # Open the sim UDP circuit (presence, groups, chat, IMs).
    old = CIRCUITS.pop(session_id, None)
    if old:
        old.stop_requested = True
    if agent_id and sl_session and circuit_code and sim_ip and sim_port:
        try:
            circ = Circuit(
                session_id=session_id,
                agent_id=str(agent_id),
                sl_session_id=str(sl_session),
                circuit_code=int(circuit_code),
                sim_ip=str(sim_ip),
                sim_port=int(sim_port),
                avatar_name=avatar_name,
                caps=caps,
                db=sync_db,
            )
            CIRCUITS[session_id] = circ
            circ.start()
        except Exception as e:
            log.exception("could not start sim circuit")
    else:
        log.warning("login response missing circuit fields; running without sim circuit")

    return LoginResponse(
        ok=True,
        session_id=session_id,
        mode="grid",
        grid=req.grid,
        avatar_name=avatar_name,
        agent_id=str(agent_id) if agent_id else None,
        sl_session_id=str(sl_session) if sl_session else None,
        sim_ip=str(sim_ip) if sim_ip else None,
        sim_port=int(sim_port) if sim_port else None,
        region=region,
        look_at=str(look_at) if look_at is not None else None,
        seed_capability=str(seed_cap) if seed_cap else None,
        login_message=str(login_msg) if login_msg else None,
        friends_count=len(friends),
        inventory_folders=len(inventory),
    )


@api.post("/login/grid", response_model=LoginResponse)
async def login_grid(req: LoginRequest):
    return await _grid_login(
        first=req.first, last=req.last or "Resident", passwd_hash=_sl_password(req.password),
        grid=req.grid, start=req.start, agree_to_tos=req.agree_to_tos, session_id=str(uuid.uuid4()),
    )


@api.post("/reconnect", response_model=LoginResponse)
async def reconnect(session_id: str):
    """Re-run the grid handshake for an existing session whose circuit died
    (backend restart, sim timeout, kick). Keeps session_id + chat history."""
    sess = await db.sessions.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    if sess.get("mode") == "offline":
        raise HTTPException(status_code=400, detail="Offline sessions have nothing to reconnect")
    creds = sess.get("login_creds")
    if not creds:
        raise HTTPException(status_code=400, detail="No stored login for this session - log in again")
    circ = CIRCUITS.get(session_id)
    if circ and circ.connected and not circ.closed:
        # Already live: tear it down first so SL releases the avatar's single circuit.
        await asyncio.to_thread(circ.logout)
        CIRCUITS.pop(session_id, None)
        await asyncio.sleep(2)
    return await _grid_login(
        first=creds["first"], last=creds["last"], passwd_hash=creds["passwd_hash"],
        grid=creds["grid"], start="last", agree_to_tos=True, session_id=session_id,
    )


@api.post("/logout")
async def logout(session_id: str):
    circ = CIRCUITS.pop(session_id, None)
    if circ:
        await asyncio.to_thread(circ.logout)
    await db.sessions.delete_one({"session_id": session_id})
    await db.friends.delete_many({"session_id": session_id})
    await db.inventory.delete_many({"session_id": session_id})
    await db.chat.delete_many({"session_id": session_id})
    await db.groups.delete_many({"session_id": session_id})
    await db.friend_requests.delete_many({"session_id": session_id})
    await db.read_marks.delete_many({"session_id": session_id})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Friend requests (incoming FriendshipOffered IMs captured by the circuit)
# ---------------------------------------------------------------------------
@api.get("/friends/requests", response_model=List[FriendRequestIn])
async def list_friend_requests(session_id: str):
    docs = await db.friend_requests.find({"session_id": session_id, "status": "pending"}, {"_id": 0}).sort("ts", -1).to_list(100)
    return [FriendRequestIn(**d) for d in docs]


async def _answer_friend_request(session_id: str, request_id: str, accept: bool):
    sess = await db.sessions.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    fr = await db.friend_requests.find_one({"session_id": session_id, "id": request_id, "status": "pending"})
    if not fr:
        raise HTTPException(status_code=404, detail="Request not found or already answered")
    if sess.get("mode") == "grid":
        circ = CIRCUITS.get(session_id)
        if not circ or not circ.connected:
            raise HTTPException(status_code=503, detail="Not connected to the sim - reconnect first")
        if accept:
            await asyncio.to_thread(circ.accept_friendship, request_id, sess.get("calling_cards_folder") or "00000000-0000-0000-0000-000000000000")
        else:
            await asyncio.to_thread(circ.decline_friendship, request_id)
    if accept:
        await db.friends.update_one(
            {"session_id": session_id, "id": fr["from_id"]},
            {"$set": {"id": fr["from_id"], "name": fr["from_name"], "online": True,
                      "can_see_me_online": True, "can_see_me_map": False, "can_modify_my_objects": False}},
            upsert=True,
        )
    await db.friend_requests.update_one({"session_id": session_id, "id": request_id}, {"$set": {"status": "accepted" if accept else "declined"}})
    await db.chat.insert_one(ChatMessage(
        session_id=session_id, channel="local", scope="local", scope_name="Local Chat", sender="System",
        text=f"You {'accepted' if accept else 'declined'} {fr['from_name']}'s friendship offer", system=True,
    ).model_dump())
    return {"ok": True, "status": "accepted" if accept else "declined", "friend_id": fr["from_id"]}


@api.post("/friends/requests/{request_id}/accept")
async def accept_friend_request(request_id: str, session_id: str):
    return await _answer_friend_request(session_id, request_id, True)


@api.post("/friends/requests/{request_id}/decline")
async def decline_friend_request(request_id: str, session_id: str):
    return await _answer_friend_request(session_id, request_id, False)


# ---------------------------------------------------------------------------
# Radar: CoarseLocationUpdate gives every avatar in the region (x, y, z*4)
# ---------------------------------------------------------------------------
@api.get("/radar", response_model=RadarResponse)
async def radar(session_id: str):
    sess = await db.sessions.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    friend_ids = {f["id"] async for f in db.friends.find({"session_id": session_id}, {"id": 1})}
    if sess.get("mode") == "offline":
        me = (128.0, 128.0, 24.0)
        mock = [("Ruth Resident", 131, 130, 24), ("Governor Linden", 120, 136, 24), ("Torley Linden", 142, 118, 28), ("Magnum Resident", 110, 150, 24), ("Philip Linden", 160, 100, 32)]
        avatars = [RadarAvatar(id=_md5(n), name=n, x=x, y=y, z=z, distance=round(math.dist(me, (x, y, z)), 1), is_friend=_md5(n) in friend_ids) for n, x, y, z in mock]
        return RadarResponse(region_name="GridLink Sandbox", connected=True, my_position=list(me), updated_ago_s=0, avatars=sorted(avatars, key=lambda a: a.distance))
    circ = CIRCUITS.get(session_id)
    if not circ:
        return RadarResponse(region_name=sess.get("region_name"), connected=False, my_position=None, updated_ago_s=None, avatars=[])
    nearby = dict(circ.nearby)
    me = circ.my_pos
    # Names: friends from DB, everything else via GetDisplayNames (cached on the circuit).
    names: Dict[str, str] = {f["id"]: f["name"] async for f in db.friends.find({"session_id": session_id, "id": {"$in": list(nearby)}}, {"id": 1, "name": 1})}
    unknown = [a for a in nearby if a not in names and a not in circ.name_cache]
    cap = (sess.get("caps") or {}).get("GetDisplayNames")
    if unknown and cap:
        recs = await asyncio.to_thread(_resolve_names, cap, unknown)
        for aid, rec in recs.items():
            circ.name_cache[aid] = _pretty_name(rec, aid)
    avatars = []
    for aid, (x, y, z) in nearby.items():
        dist = round(math.dist(me, (x, y, z)), 1) if me else None
        avatars.append(RadarAvatar(id=aid, name=names.get(aid) or circ.name_cache.get(aid) or f"Resident {aid[:8]}", x=x, y=y, z=z, distance=dist, is_friend=aid in friend_ids))
    avatars.sort(key=lambda a: (a.distance is None, a.distance or 0))
    return RadarResponse(
        region_name=circ.region_name or sess.get("region_name"), connected=circ.connected,
        my_position=list(me) if me else None,
        updated_ago_s=round(time.time() - circ.nearby_updated, 1) if circ.nearby_updated else None,
        avatars=avatars,
    )


# ---------------------------------------------------------------------------
# Unread counts per IM / group scope
# ---------------------------------------------------------------------------
@api.get("/chat/unread", response_model=List[UnreadEntry])
async def chat_unread(session_id: str):
    sess = await db.sessions.find_one({"session_id": session_id}, {"agent_id": 1, "avatar_name": 1})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    marks = {(m["channel"], m["scope"]): m["ts"] async for m in db.read_marks.find({"session_id": session_id}, {"_id": 0})}
    q: Dict[str, Any] = {"session_id": session_id, "channel": {"$in": ["im", "group"]}, "system": False}
    if sess.get("agent_id"):
        q["sender_id"] = {"$ne": sess["agent_id"]}
    else:
        q["sender"] = {"$ne": sess.get("avatar_name")}
    counts: Dict[tuple, Dict[str, Any]] = {}
    async for m in db.chat.find(q, {"_id": 0, "channel": 1, "scope": 1, "scope_name": 1, "ts": 1}):
        key = (m["channel"], m["scope"])
        if m["ts"] <= marks.get(key, ""):
            continue
        e = counts.setdefault(key, {"channel": m["channel"], "scope": m["scope"], "scope_name": m.get("scope_name"), "count": 0})
        e["count"] += 1
        e["scope_name"] = m.get("scope_name") or e["scope_name"]
    return [UnreadEntry(**e) for e in counts.values()]


@api.post("/chat/mark_read")
async def chat_mark_read(req: MarkReadRequest):
    await db.read_marks.update_one(
        {"session_id": req.session_id, "channel": req.channel, "scope": req.scope},
        {"$set": {"ts": datetime.now(timezone.utc).isoformat()}},
        upsert=True,
    )
    return {"ok": True}


@api.get("/status")
async def get_status(session_id: str):
    """Live sim-circuit state for a session (offline sessions report mode only)."""
    sess = await db.sessions.find_one({"session_id": session_id}, {"_id": 0, "mode": 1, "region_name": 1, "avatar_name": 1, "login_creds": 1})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    circ = CIRCUITS.get(session_id)
    if sess.get("mode") == "offline":
        return {"mode": "offline", "connected": True, "can_reconnect": False, "region_name": "GridLink Sandbox", "avatar_name": sess.get("avatar_name")}
    can_reconnect = bool(sess.get("login_creds"))
    if not circ:
        return {"mode": "grid", "connected": False, "closed": True, "can_reconnect": can_reconnect,
                "error": "sim link lost (backend restarted)", "region_name": sess.get("region_name"), "avatar_name": sess.get("avatar_name")}
    return {"mode": "grid", "avatar_name": sess.get("avatar_name"), "can_reconnect": can_reconnect, **circ.status()}


@api.get("/groups", response_model=List[Group])
async def get_groups(session_id: str):
    docs = await db.groups.find({"session_id": session_id}, {"_id": 0}).sort("name", 1).to_list(500)
    return [Group(**d) for d in docs]


@api.get("/im/conversations", response_model=List[Conversation])
async def get_conversations(session_id: str):
    pipeline = [
        {"$match": {"session_id": session_id, "channel": "im"}},
        {"$sort": {"ts": 1}},
        {"$group": {"_id": "$scope", "name": {"$last": "$scope_name"}, "last_ts": {"$last": "$ts"}, "last_text": {"$last": "$text"}}},
        {"$sort": {"last_ts": -1}},
    ]
    docs = await db.chat.aggregate(pipeline).to_list(200)
    return [Conversation(id=d["_id"], name=d.get("name") or "Resident", last_ts=d["last_ts"], last_text=d.get("last_text") or "") for d in docs]


@api.get("/search/residents", response_model=List[SearchResult])
async def search_residents(session_id: str, q: str):
    q = q.strip()
    if len(q) < 2:
        return []
    sess = await db.sessions.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    friend_ids = {f["id"] async for f in db.friends.find({"session_id": session_id}, {"id": 1})}
    if sess.get("mode") == "offline":
        pool = ["Ruth Resident", "Governor Linden", "Torley Linden", "Philip Linden", "Magnum Resident",
                "Oz Linden", "Ebbe Linden", "Rodvik Linden", "Grumpity Linden", "Patch Linden", "Vir Linden"]
        hits = [{"id": _md5(n), "name": n, "username": n.lower().replace(" ", ".")} for n in pool if q.lower() in n.lower()]
    else:
        cap = (sess.get("caps") or {}).get("AvatarPickerSearch")
        if not cap:
            raise HTTPException(status_code=400, detail="Resident search capability unavailable for this session")
        hits = await asyncio.to_thread(_search_residents, cap, q)
    return [SearchResult(**h, is_friend=h["id"] in friend_ids) for h in hits]


@api.post("/friends/request")
async def request_friendship(req: FriendRequest):
    sess = await db.sessions.find_one({"session_id": req.session_id})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    if sess.get("mode") == "offline":
        await db.friends.update_one(
            {"session_id": req.session_id, "id": req.agent_id},
            {"$set": {"id": req.agent_id, "name": req.name or f"Resident {req.agent_id[:8]}", "online": True,
                      "can_see_me_online": True, "can_see_me_map": False, "can_modify_my_objects": False}},
            upsert=True,
        )
        return {"ok": True, "delivered": "offline"}
    circ = CIRCUITS.get(req.session_id)
    if not circ or not circ.connected:
        raise HTTPException(status_code=503, detail="Not connected to the sim - log in again")
    await asyncio.to_thread(circ.request_friendship, req.agent_id, req.message)
    await db.chat.insert_one(ChatMessage(
        session_id=req.session_id, channel="local", scope="local", scope_name="Local Chat",
        sender="System", text=f"Friendship offered to {req.name or req.agent_id}", system=True,
    ).model_dump())
    return {"ok": True, "delivered": "grid"}


@api.get("/session")
async def get_session(session_id: str):
    doc = await db.sessions.find_one({"session_id": session_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Session not found")
    return _clean(doc)


@api.get("/friends", response_model=List[Friend])
async def get_friends(session_id: str):
    docs = await db.friends.find({"session_id": session_id}, {"_id": 0, "session_id": 0}).sort([("online", -1), ("name", 1)]).to_list(5000)
    return [Friend(**d) for d in docs]


@api.post("/friends/refresh_names")
async def refresh_friend_names(session_id: str):
    """Re-resolve display names for every friend in a session using the stored
    seed_capability. Useful when a session was created before name resolution
    landed, or when a resident has since changed their display name."""
    sess = await db.sessions.find_one({"session_id": session_id})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    seed = sess.get("seed_capability")
    if not seed:
        raise HTTPException(status_code=400, detail="Session has no seed capability (offline mode?)")
    friends = await db.friends.find({"session_id": session_id}, {"_id": 0}).to_list(5000)
    if not friends:
        return {"updated": 0}
    cap_url = await asyncio.to_thread(_fetch_display_name_cap, str(seed))
    if not cap_url:
        raise HTTPException(status_code=502, detail="GetDisplayNames capability unavailable")
    ids = [f["id"] for f in friends]
    if sess.get("agent_id"):
        ids.append(str(sess["agent_id"]))
    names = await asyncio.to_thread(_resolve_names, cap_url, ids)
    updated = 0
    for f in friends:
        rec = names.get(f["id"].lower())
        if rec:
            new_name = _pretty_name(rec, f["id"])
            if new_name != f.get("name"):
                await db.friends.update_one(
                    {"session_id": session_id, "id": f["id"]},
                    {"$set": {"name": new_name}},
                )
                updated += 1
    # Update session avatar name too
    if sess.get("agent_id"):
        self_rec = names.get(str(sess["agent_id"]).lower())
        if self_rec:
            new_self = _pretty_name(self_rec, str(sess["agent_id"]))
            await db.sessions.update_one(
                {"session_id": session_id},
                {"$set": {"avatar_name": new_self}},
            )
    return {"updated": updated, "resolved": len(names)}


@api.get("/inventory", response_model=List[InventoryFolder])
async def get_inventory(session_id: str):
    docs = await db.inventory.find({"session_id": session_id}, {"_id": 0, "session_id": 0}).to_list(1000)
    return [InventoryFolder(**d) for d in docs]


@api.get("/chat", response_model=List[ChatMessage])
async def get_chat(session_id: str, channel: str, scope: str = "local"):
    q = {"session_id": session_id, "channel": channel, "scope": scope}
    docs = await db.chat.find(q, {"_id": 0}).sort("ts", 1).to_list(500)
    return [ChatMessage(**d) for d in docs]


@api.post("/chat/send", response_model=ChatMessage)
async def send_chat(req: SendMessageRequest):
    session = await db.sessions.find_one({"session_id": req.session_id})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty message")

    if session.get("mode") == "grid":
        circ = CIRCUITS.get(req.session_id)
        if not circ or not circ.connected:
            raise HTTPException(status_code=503, detail="Not connected to the sim - log in again")
        if req.channel == "local":
            await asyncio.to_thread(circ.send_local_chat, text)
        elif req.channel == "im":
            await asyncio.to_thread(circ.send_im, req.scope, text)
        else:
            await asyncio.to_thread(circ.send_group_im, req.scope, text)

    msg = ChatMessage(
        session_id=req.session_id,
        channel=req.channel,
        scope=req.scope,
        scope_name=req.scope_name or ("Local Chat" if req.channel == "local" else None),
        sender=session["avatar_name"],
        sender_id=session.get("agent_id"),
        text=text,
    )
    await db.chat.insert_one(msg.model_dump())

    # Auto-append a simulated system echo on offline mode so channel feels alive
    if session.get("mode") == "offline" and req.channel == "local":
        echo = ChatMessage(
            session_id=req.session_id,
            channel="local",
            scope="local",
            scope_name="Local Chat",
            sender="System",
            text=f"Local chat delivered on region 'GridLink Sandbox' (radius 20m).",
            system=True,
        )
        await db.chat.insert_one(echo.model_dump())
    return msg


@api.get("/diagnostics", response_model=Diagnostics)
async def diagnostics(grid: str = "agni"):
    if grid not in GRIDS:
        raise HTTPException(status_code=400, detail="Unknown grid")
    login_uri = GRIDS[grid]["login_uri"]
    host = login_uri.split("//", 1)[1].split("/", 1)[0]

    dns_ok = False
    dns_ms = 0.0
    reachable = False
    tls_ms = 0.0
    latency_ms: Optional[float] = None
    server_time: Optional[str] = None
    error: Optional[str] = None

    # DNS
    t0 = time.time()
    try:
        socket.gethostbyname(host)
        dns_ok = True
    except Exception as e:
        error = f"DNS: {e}"
    dns_ms = round((time.time() - t0) * 1000, 1)

    # TCP + TLS reachability
    t0 = time.time()
    try:
        with socket.create_connection((host, 443), timeout=5):
            reachable = True
    except Exception as e:
        if not error:
            error = f"TCP: {e}"
    tls_ms = round((time.time() - t0) * 1000, 1)

    # Cheap XML-RPC latency: attempt a well-formed but intentionally-invalid
    # login so we get a proper failure response back and can time the round
    # trip without needing real credentials.
    if reachable:
        try:
            t0 = time.time()
            _xmlrpc_login({
                "first": "grid",
                "last": "check",
                "passwd": _sl_password("invalid"),
                "start": "last",
                "channel": VIEWER_CHANNEL,
                "version": VIEWER_VERSION,
                "platform": VIEWER_PLATFORM,
                "mac": _stable_hex("diag-mac"),
                "id0": _stable_hex("diag-id0"),
                "agree_to_tos": "false",
                "read_critical": "false",
                "options": [],
            }, login_uri)
            latency_ms = round((time.time() - t0) * 1000, 1)
            server_time = datetime.now(timezone.utc).isoformat()
        except xmlrpc.client.Fault as f:
            latency_ms = round((time.time() - t0) * 1000, 1)
            server_time = datetime.now(timezone.utc).isoformat()
            if not error:
                error = f"XML-RPC fault: {f.faultString}"
        except Exception as e:
            if not error:
                error = f"XML-RPC: {e}"

    return Diagnostics(
        grid=grid,
        login_uri=login_uri,
        dns_ok=dns_ok,
        dns_ms=dns_ms,
        reachable=reachable,
        tls_ms=tls_ms,
        latency_ms=latency_ms,
        server_time=server_time,
        viewer_channel=VIEWER_CHANNEL,
        viewer_version=VIEWER_VERSION,
        error=error,
    )


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    for circ in list(CIRCUITS.values()):
        try:
            circ.logout()
        except Exception:
            pass
    CIRCUITS.clear()
    client.close()
