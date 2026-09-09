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
import socket
import time
import uuid
import xmlrpc.client
from pathlib import Path
from datetime import datetime, timezone
from typing import List, Optional, Literal, Dict, Any
from pydantic import BaseModel, Field

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

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
    scope: str  # "local" | im peer name | group name
    sender: str
    text: str
    ts: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    system: bool = False


class SendMessageRequest(BaseModel):
    session_id: str
    channel: Literal["local", "im", "group"]
    scope: str
    text: str


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


@api.post("/login/grid", response_model=LoginResponse)
async def login_grid(req: LoginRequest):
    if req.grid not in GRIDS:
        raise HTTPException(status_code=400, detail="Unknown grid")
    login_uri = GRIDS[req.grid]["login_uri"]

    mac = _stable_hex(f"mac::{req.first}::{req.last}")
    id0 = _stable_hex(f"id0::{req.first}::{req.last}")

    payload = {
        "first": req.first,
        "last": req.last or "Resident",
        "passwd": _sl_password(req.password),
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

    # Buddy list -> friends
    buddies = resp.get("buddy-list") or []
    friends: List[Dict[str, Any]] = []
    for b in buddies:
        if not isinstance(b, dict):
            continue
        buddy_id = b.get("buddy_id") or str(uuid.uuid4())
        rights_given = int(b.get("buddy_rights_given", 0) or 0)
        rights_has = int(b.get("buddy_rights_has", 0) or 0)
        friends.append({
            "id": buddy_id,
            "name": b.get("buddy_name") or f"Resident {buddy_id[:6]}",
            "online": bool(rights_has & 1),
            "can_see_me_online": bool(rights_given & 1),
            "can_see_me_map": bool(rights_given & 2),
            "can_modify_my_objects": bool(rights_given & 4),
        })

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

    session_id = str(uuid.uuid4())
    region = f"{region_x},{region_y}" if region_x is not None else None

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
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.sessions.insert_one(dict(session_doc))
    if friends:
        await db.friends.insert_many([{**fr, "session_id": session_id} for fr in friends])
    await db.inventory.insert_many([{**it, "session_id": session_id} for it in inventory])

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


@api.post("/logout")
async def logout(session_id: str):
    await db.sessions.delete_one({"session_id": session_id})
    await db.friends.delete_many({"session_id": session_id})
    await db.inventory.delete_many({"session_id": session_id})
    await db.chat.delete_many({"session_id": session_id})
    return {"ok": True}


@api.get("/session")
async def get_session(session_id: str):
    doc = await db.sessions.find_one({"session_id": session_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Session not found")
    return _clean(doc)


@api.get("/friends", response_model=List[Friend])
async def get_friends(session_id: str):
    docs = await db.friends.find({"session_id": session_id}, {"_id": 0, "session_id": 0}).to_list(500)
    return [Friend(**d) for d in docs]


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
    msg = ChatMessage(
        session_id=req.session_id,
        channel=req.channel,
        scope=req.scope,
        sender=session["avatar_name"],
        text=req.text,
    )
    await db.chat.insert_one(msg.model_dump())

    # Auto-append a simulated system echo on offline mode so channel feels alive
    if session.get("mode") == "offline" and req.channel == "local":
        echo = ChatMessage(
            session_id=req.session_id,
            channel="local",
            scope="local",
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
    client.close()
