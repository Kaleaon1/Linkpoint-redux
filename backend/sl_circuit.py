"""
LLUDP sim circuit for GridLink.

After the XML-RPC login we open the same UDP circuit a viewer does
(UseCircuitCode -> CompleteAgentMovement -> AgentThrottle, then AgentUpdate
keep-alives).  That is what makes the sim treat us as "in world": it starts
pushing OnlineNotification / OfflineNotification for friends,
AgentGroupDataUpdate for our groups, ChatFromSimulator for local chat and
ImprovedInstantMessage for IMs / group chat / friendship offers.

Only the handful of messages a text communicator needs are hand-encoded here
(see message_template.msg for the field layouts).  Header is 6 bytes:
flags, uint32 BE sequence, extra-header length.  Body ints are little-endian,
message ids are High (1 byte) / Medium (FF xx) / Low (FF FF xxxx) / Fixed
(FF FF FF xx).  ZEROCODED (0x80) bodies run-length-encode zero bytes.

Group data and group chat invitations also arrive on the HTTP EventQueueGet
capability, so a second thread long-polls that.
"""
import logging
import select
import socket
import struct
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests

import llsd

log = logging.getLogger("gridlink.circuit")

ZERO_UUID = "00000000-0000-0000-0000-000000000000"


def _high(n: int) -> bytes:
    return bytes([n])


def _med(n: int) -> bytes:
    return bytes([0xFF, n])


def _low(n: int) -> bytes:
    return b"\xff\xff" + struct.pack(">H", n)


def _fixed(n: int) -> bytes:
    return b"\xff\xff\xff" + bytes([n])


MSG_START_PING = _high(1)
MSG_COMPLETE_PING = _high(2)
MSG_AGENT_UPDATE = _high(4)
MSG_CHAT_FROM_SIM = _med(139)
MSG_USE_CIRCUIT = _low(3)
MSG_CHAT_FROM_VIEWER = _low(80)
MSG_AGENT_THROTTLE = _low(81)
MSG_REGION_HANDSHAKE = _low(148)
MSG_REGION_HANDSHAKE_REPLY = _low(149)
MSG_KICK_USER = _low(163)
MSG_COMPLETE_MOVEMENT = _low(249)
MSG_MOVEMENT_COMPLETE = _low(250)
MSG_LOGOUT_REQUEST = _low(252)
MSG_LOGOUT_REPLY = _low(253)
MSG_IM = _low(254)
MSG_RETRIEVE_IMS = _low(255)
MSG_ONLINE = _low(322)
MSG_OFFLINE = _low(323)
MSG_GROUP_DATA = _low(389)
MSG_PACKET_ACK = _fixed(0xFB)

FLAG_ZEROCODED = 0x80
FLAG_RELIABLE = 0x40
FLAG_RESENT = 0x20
FLAG_ACK = 0x10

# ImprovedInstantMessage dialog codes
IM_MESSAGE_FROM_AGENT = 0
IM_SESSION_GROUP_START = 15
IM_SESSION_SEND = 17
IM_MESSAGE_FROM_OBJECT = 19
IM_FRIENDSHIP_OFFERED = 38
IM_FRIENDSHIP_ACCEPTED = 39
IM_FRIENDSHIP_DECLINED = 40
IM_TYPING = (41, 42)

# ChatFromSimulator chat types we hide
CHAT_TYPING = (4, 5)


# ---------------------------------------------------------------------------
# byte helpers
# ---------------------------------------------------------------------------
def U(u: str) -> bytes:
    return uuid.UUID(u).bytes


def var1(b: bytes) -> bytes:
    return bytes([len(b)]) + b


def var2(b: bytes) -> bytes:
    return struct.pack("<H", len(b)) + b


def cstr(s: str) -> bytes:
    return s.encode("utf-8") + b"\0"


def zero_decode(b: bytes) -> bytes:
    out = bytearray()
    i, n = 0, len(b)
    while i < n:
        if b[i] == 0 and i + 1 < n:
            out.extend(b"\0" * b[i + 1])
            i += 2
        else:
            out.append(b[i])
            i += 1
    return bytes(out)


class Reader:
    def __init__(self, b: bytes, i: int = 0):
        self.b = b
        self.i = i

    def u8(self) -> int:
        v = self.b[self.i]
        self.i += 1
        return v

    def u16(self) -> int:
        v = struct.unpack_from("<H", self.b, self.i)[0]
        self.i += 2
        return v

    def u32(self) -> int:
        v = struct.unpack_from("<I", self.b, self.i)[0]
        self.i += 4
        return v

    def s32(self) -> int:
        v = struct.unpack_from("<i", self.b, self.i)[0]
        self.i += 4
        return v

    def u64(self) -> int:
        v = struct.unpack_from("<Q", self.b, self.i)[0]
        self.i += 8
        return v

    def uuid(self) -> str:
        v = str(uuid.UUID(bytes=bytes(self.b[self.i : self.i + 16])))
        self.i += 16
        return v

    def skip(self, n: int) -> None:
        self.i += n

    def var1(self) -> bytes:
        n = self.u8()
        v = self.b[self.i : self.i + n]
        self.i += n
        return bytes(v)

    def var2(self) -> bytes:
        n = self.u16()
        v = self.b[self.i : self.i + n]
        self.i += n
        return bytes(v)

    def text1(self) -> str:
        return self.var1().rstrip(b"\0").decode("utf-8", "replace")

    def text2(self) -> str:
        return self.var2().rstrip(b"\0").decode("utf-8", "replace")


def split_msg_id(body: bytes):
    if body[0] != 0xFF:
        return body[:1], body[1:]
    if body[1] != 0xFF:
        return body[:2], body[2:]
    return body[:4], body[4:]


def im_session_id(a: str, b: str) -> str:
    """Viewer convention: 1:1 IM session id = agent XOR agent."""
    return str(uuid.UUID(int=uuid.UUID(a).int ^ uuid.UUID(b).int))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Circuit
# ---------------------------------------------------------------------------
class Circuit:
    def __init__(
        self,
        *,
        session_id: str,
        agent_id: str,
        sl_session_id: str,
        circuit_code: int,
        sim_ip: str,
        sim_port: int,
        avatar_name: str,
        caps: Dict[str, str],
        db,
    ):
        self.session_id = session_id
        self.agent_id = agent_id
        self.sl_session_id = sl_session_id
        self.circuit_code = int(circuit_code)
        self.addr = (sim_ip, int(sim_port))
        self.avatar_name = avatar_name
        self.caps = caps or {}
        self.db = db  # sync pymongo database

        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setblocking(False)
        self.lock = threading.Lock()
        self.seq = 0
        self.unacked: Dict[int, List[Any]] = {}
        self.pending_acks: List[int] = []
        self.seen: deque = deque(maxlen=4000)
        self.seen_set: set = set()
        self.group_sessions: set = set()

        self.started_at = time.time()
        self.last_rx = 0.0
        self.last_agent_update = 0.0
        self.connected = False
        self.closed = False
        self.stop_requested = False
        self.error: Optional[str] = None
        self.region_name: Optional[str] = None
        self.rx_packets = 0
        self.tx_packets = 0
        self.eq_polls = 0
        self.events: deque = deque(maxlen=60)

    # -- lifecycle ----------------------------------------------------------
    def start(self) -> None:
        threading.Thread(target=self._run, name=f"udp-{self.session_id[:8]}", daemon=True).start()
        if self.caps.get("EventQueueGet"):
            threading.Thread(target=self._eq_loop, name=f"eq-{self.session_id[:8]}", daemon=True).start()

    def logout(self) -> None:
        if not self.closed:
            try:
                self._send(MSG_LOGOUT_REQUEST + U(self.agent_id) + U(self.sl_session_id), reliable=True)
            except Exception:
                pass
            time.sleep(0.3)
        self._shutdown("logout")

    def _shutdown(self, reason: str) -> None:
        if self.closed:
            return
        self.closed = True
        self.connected = False
        self.error = self.error or reason
        self._event(f"circuit closed: {reason}")
        try:
            self.sock.close()
        except Exception:
            pass
        try:
            self.db.friends.update_many({"session_id": self.session_id}, {"$set": {"online": False}})
        except Exception:
            pass

    def status(self) -> Dict[str, Any]:
        return {
            "connected": self.connected,
            "closed": self.closed,
            "error": self.error,
            "region_name": self.region_name,
            "sim": f"{self.addr[0]}:{self.addr[1]}",
            "uptime_s": round(time.time() - self.started_at, 1),
            "last_rx_age_s": round(time.time() - self.last_rx, 1) if self.last_rx else None,
            "rx_packets": self.rx_packets,
            "tx_packets": self.tx_packets,
            "eq_polls": self.eq_polls,
            "unacked": len(self.unacked),
            "events": list(self.events),
        }

    def _event(self, text: str) -> None:
        log.info("[%s] %s", self.session_id[:8], text)
        self.events.append(f"{datetime.now(timezone.utc).strftime('%H:%M:%S')} {text}")

    # -- sending ------------------------------------------------------------
    def _send(self, body: bytes, reliable: bool = False) -> None:
        if self.closed:
            return
        with self.lock:
            self.seq += 1
            seq = self.seq
            flags = FLAG_RELIABLE if reliable else 0
            pkt = bytes([flags]) + struct.pack(">I", seq) + b"\0" + body
            self.sock.sendto(pkt, self.addr)
            self.tx_packets += 1
            if reliable:
                self.unacked[seq] = [pkt, time.time(), 0]

    def _flush_acks(self) -> None:
        with self.lock:
            acks = self.pending_acks[:255]
            del self.pending_acks[: len(acks)]
        if acks:
            self._send(MSG_PACKET_ACK + bytes([len(acks)]) + b"".join(struct.pack("<I", a) for a in acks))

    def _resend(self) -> None:
        now = time.time()
        with self.lock:
            items = list(self.unacked.items())
        for seq, rec in items:
            pkt, sent, tries = rec
            if now - sent < 1.5:
                continue
            if tries >= 5:
                with self.lock:
                    self.unacked.pop(seq, None)
                continue
            rec[1] = now
            rec[2] = tries + 1
            try:
                self.sock.sendto(bytes([pkt[0] | FLAG_RESENT]) + pkt[1:], self.addr)
            except Exception:
                pass

    def _agent_update(self) -> None:
        body = (
            MSG_AGENT_UPDATE
            + U(self.agent_id)
            + U(self.sl_session_id)
            + struct.pack("<3f", 0, 0, 0)  # BodyRotation
            + struct.pack("<3f", 0, 0, 0)  # HeadRotation
            + b"\0"  # State
            + struct.pack("<3f", 128, 128, 25)  # CameraCenter
            + struct.pack("<3f", 1, 0, 0)  # CameraAtAxis
            + struct.pack("<3f", 0, 1, 0)  # CameraLeftAxis
            + struct.pack("<3f", 0, 0, 1)  # CameraUpAxis
            + struct.pack("<f", 64.0)  # Far
            + struct.pack("<I", 0)  # ControlFlags
            + b"\0"  # Flags
        )
        self._send(body)
        self.last_agent_update = time.time()

    def send_local_chat(self, text: str, chat_type: int = 1, channel: int = 0) -> None:
        body = (
            MSG_CHAT_FROM_VIEWER
            + U(self.agent_id)
            + U(self.sl_session_id)
            + var2(cstr(text))
            + bytes([chat_type])
            + struct.pack("<i", channel)
        )
        self._send(body, reliable=True)

    def send_im(
        self,
        to_id: str,
        text: str,
        dialog: int = IM_MESSAGE_FROM_AGENT,
        im_id: Optional[str] = None,
        bucket: bytes = b"",
        from_group: bool = False,
    ) -> None:
        im_id = im_id or im_session_id(self.agent_id, to_id)
        body = (
            MSG_IM
            + U(self.agent_id)
            + U(self.sl_session_id)
            + bytes([1 if from_group else 0])
            + U(to_id)
            + struct.pack("<I", 0)  # ParentEstateID
            + U(ZERO_UUID)  # RegionID
            + struct.pack("<3f", 0, 0, 0)  # Position
            + b"\0"  # Offline
            + bytes([dialog])
            + U(im_id)
            + struct.pack("<I", 0)  # Timestamp
            + var1(cstr(self.avatar_name))
            + var2(cstr(text))
            + var2(bucket)
        )
        self._send(body, reliable=True)

    def send_group_im(self, group_id: str, text: str) -> None:
        if group_id not in self.group_sessions:
            self.send_im(group_id, "", dialog=IM_SESSION_GROUP_START, im_id=group_id)
            self.group_sessions.add(group_id)
            time.sleep(0.4)
        self.send_im(group_id, text, dialog=IM_SESSION_SEND, im_id=group_id)

    def request_friendship(self, agent_id: str, message: str) -> None:
        self.send_im(agent_id, message or "Would you be my friend?", dialog=IM_FRIENDSHIP_OFFERED, im_id=str(uuid.uuid4()))

    # -- receive loop -------------------------------------------------------
    def _run(self) -> None:
        try:
            self._event(f"opening circuit to {self.addr[0]}:{self.addr[1]}")
            self._send(MSG_USE_CIRCUIT + struct.pack("<I", self.circuit_code) + U(self.sl_session_id) + U(self.agent_id), reliable=True)
            self._send(MSG_COMPLETE_MOVEMENT + U(self.agent_id) + U(self.sl_session_id) + struct.pack("<I", self.circuit_code), reliable=True)
            throttles = struct.pack("<7f", 100000, 20000, 4000, 4000, 120000, 20000, 20000)  # we only need chat/IM traffic, keep object/texture streams low
            self._send(
                MSG_AGENT_THROTTLE + U(self.agent_id) + U(self.sl_session_id) + struct.pack("<I", self.circuit_code) + struct.pack("<I", 0) + var1(throttles),
                reliable=True,
            )
            self._agent_update()
            while not self.closed and not self.stop_requested:
                r, _, _ = select.select([self.sock], [], [], 0.25)
                if r:
                    try:
                        data, _ = self.sock.recvfrom(8192)
                        self._handle(data)
                    except BlockingIOError:
                        pass
                    except Exception as e:
                        log.warning("packet handler error: %s", e)
                now = time.time()
                if now - self.last_agent_update > 1.0:
                    self._agent_update()
                if self.pending_acks:
                    self._flush_acks()
                self._resend()
                if self.last_rx and now - self.last_rx > 90:
                    self.error = "sim timeout (no packets for 90s)"
                    break
                if not self.last_rx and now - self.started_at > 30:
                    self.error = "sim never answered (UDP blocked?)"
                    break
        except Exception as e:
            self.error = f"circuit error: {e}"
            log.exception("circuit crashed")
        finally:
            self._shutdown(self.error or "stopped")

    def _handle(self, data: bytes) -> None:
        if len(data) < 7:
            return
        self.last_rx = time.time()
        self.rx_packets += 1
        flags = data[0]
        seq = struct.unpack_from(">I", data, 1)[0]
        extra = data[5]
        end = len(data)
        if flags & FLAG_ACK:
            n = data[-1]
            end = len(data) - 1 - 4 * n
            for k in range(n):
                self._acked(struct.unpack_from(">I", data, end + 4 * k)[0])
        body = data[6:end]
        if flags & FLAG_ZEROCODED:
            body = zero_decode(body)
        body = body[extra:]
        if flags & FLAG_RELIABLE:
            with self.lock:
                self.pending_acks.append(seq)
        if seq in self.seen_set:
            return
        if len(self.seen) == self.seen.maxlen:
            self.seen_set.discard(self.seen[0])
        self.seen.append(seq)
        self.seen_set.add(seq)
        if not body:
            return
        mid, payload = split_msg_id(body)
        self._dispatch(mid, payload)

    def _acked(self, seq: int) -> None:
        with self.lock:
            self.unacked.pop(seq, None)

    def _dispatch(self, mid: bytes, p: bytes) -> None:
        r = Reader(p)
        if mid == MSG_PACKET_ACK:
            for _ in range(r.u8()):
                self._acked(r.u32())
        elif mid == MSG_START_PING:
            ping_id = r.u8()
            self._send(MSG_COMPLETE_PING + bytes([ping_id]))
        elif mid == MSG_REGION_HANDSHAKE:
            r.u32()  # RegionFlags
            r.u8()  # SimAccess
            self.region_name = r.text1()
            self._event(f"region handshake: {self.region_name}")
            self._send(MSG_REGION_HANDSHAKE_REPLY + U(self.agent_id) + U(self.sl_session_id) + struct.pack("<I", 0), reliable=True)
            self.db.sessions.update_one({"session_id": self.session_id}, {"$set": {"region_name": self.region_name}})
        elif mid == MSG_MOVEMENT_COMPLETE:
            if not self.connected:
                self.connected = True
                self._event("agent movement complete - in world")
                self._send(MSG_RETRIEVE_IMS + U(self.agent_id) + U(self.sl_session_id), reliable=True)
        elif mid == MSG_CHAT_FROM_SIM:
            self._on_chat(r)
        elif mid == MSG_IM:
            self._on_im(r)
        elif mid in (MSG_ONLINE, MSG_OFFLINE):
            online = mid == MSG_ONLINE
            ids = [r.uuid() for _ in range(r.u8())]
            if ids:
                self.db.friends.update_many({"session_id": self.session_id, "id": {"$in": ids}}, {"$set": {"online": online}})
                self._event(f"{'online' if online else 'offline'}: {len(ids)} friend(s)")
        elif mid == MSG_GROUP_DATA:
            r.uuid()  # AgentID
            groups = []
            for _ in range(r.u8()):
                gid = r.uuid()
                powers = r.u64()
                accept = r.u8()
                insignia = r.uuid()
                contribution = r.s32()
                name = r.text1()
                groups.append({"id": gid, "name": name, "powers": str(powers), "accept_notices": bool(accept), "insignia_id": insignia, "contribution": contribution})
            self._store_groups(groups)
        elif mid == MSG_KICK_USER:
            r.skip(6)  # TargetIP + TargetPort
            r.uuid()
            r.uuid()
            reason = r.text2()
            self.error = f"kicked: {reason}"
            self._system(f"Disconnected by grid: {reason}")
            self.stop_requested = True
        elif mid == MSG_LOGOUT_REPLY:
            self.stop_requested = True

    # -- inbound handlers ---------------------------------------------------
    def _on_chat(self, r: Reader) -> None:
        from_name = r.text1()
        source_id = r.uuid()
        r.uuid()  # OwnerID
        source_type = r.u8()
        chat_type = r.u8()
        r.u8()  # Audible
        r.skip(12)  # Position
        message = r.text2()
        if chat_type in CHAT_TYPING or not message:
            return
        if source_id == self.agent_id:
            return  # we already stored our own line when sending
        prefix = {0: "whispers: ", 2: "shouts: "}.get(chat_type, "")
        self._insert_chat("local", "local", "Local Chat", from_name, source_id, prefix + message, system=(source_type == 0))

    def _on_im(self, r: Reader) -> None:
        from_id = r.uuid()
        r.uuid()  # SessionID (sender's)
        from_group = bool(r.u8())
        r.uuid()  # ToAgentID
        r.u32()  # ParentEstateID
        r.uuid()  # RegionID
        r.skip(12)  # Position
        r.u8()  # Offline
        dialog = r.u8()
        im_id = r.uuid()
        r.u32()  # Timestamp
        from_name = r.text1()
        message = r.text2()
        bucket = r.var2()
        if dialog in IM_TYPING:
            return
        if from_id == self.agent_id:
            return
        if from_id == ZERO_UUID:
            self._system(f"{from_name}: {message}")  # grid/system notices (deliveries, etc.)
        elif dialog == IM_SESSION_SEND or from_group:
            group_name = bucket.rstrip(b"\0").decode("utf-8", "replace") or self._group_name(im_id)
            self._insert_chat("group", im_id, group_name, from_name, from_id, message)
        elif dialog in (IM_MESSAGE_FROM_AGENT, IM_MESSAGE_FROM_OBJECT):
            self._insert_chat("im", from_id, from_name, from_name, from_id, message)
        elif dialog == IM_FRIENDSHIP_OFFERED:
            self._system(f"{from_name} has offered you friendship: {message or '(no message)'}")
        elif dialog == IM_FRIENDSHIP_ACCEPTED:
            self.db.friends.update_one(
                {"session_id": self.session_id, "id": from_id},
                {"$set": {"name": from_name, "online": True, "can_see_me_online": True, "can_see_me_map": False, "can_modify_my_objects": False}},
                upsert=True,
            )
            self._system(f"{from_name} accepted your friendship offer")
        elif dialog == IM_FRIENDSHIP_DECLINED:
            self._system(f"{from_name} declined your friendship offer")
        elif message:
            self._system(f"{from_name}: {message}")

    def _group_name(self, gid: str) -> str:
        doc = self.db.groups.find_one({"session_id": self.session_id, "id": gid}, {"name": 1})
        return doc["name"] if doc else "Group"

    def _store_groups(self, groups: List[Dict[str, Any]]) -> None:
        if not groups:
            return
        for g in groups:
            self.db.groups.update_one({"session_id": self.session_id, "id": g["id"]}, {"$set": {**g, "session_id": self.session_id}}, upsert=True)
        self._event(f"groups: {len(groups)} received")

    def _insert_chat(self, channel: str, scope: str, scope_name: str, sender: str, sender_id: str, text: str, system: bool = False) -> None:
        self.db.chat.insert_one(
            {
                "id": str(uuid.uuid4()),
                "session_id": self.session_id,
                "channel": channel,
                "scope": scope,
                "scope_name": scope_name,
                "sender": sender,
                "sender_id": sender_id,
                "text": text,
                "ts": _now(),
                "system": system,
            }
        )

    def _system(self, text: str) -> None:
        self._event(text)
        self._insert_chat("local", "local", "Local Chat", "System", ZERO_UUID, text, system=True)

    # -- event queue --------------------------------------------------------
    def _eq_loop(self) -> None:
        cap = self.caps["EventQueueGet"]
        ack: Optional[int] = None
        while not self.closed:
            try:
                r = requests.post(
                    cap,
                    data=llsd.dump({"ack": ack, "done": False}),
                    headers={"Content-Type": "application/llsd+xml"},
                    timeout=60,
                )
                self.eq_polls += 1
            except requests.RequestException:
                continue
            if r.status_code in (502, 499):
                continue  # long-poll timeout with no events
            if r.status_code == 404:
                self._event("event queue gone (404)")
                return
            if r.status_code != 200:
                time.sleep(2)
                continue
            try:
                doc = llsd.parse(r.text) or {}
            except Exception:
                continue
            ack = doc.get("id", ack)
            for ev in doc.get("events") or []:
                try:
                    self._eq_event(ev)
                except Exception as e:
                    log.warning("eq event error: %s", e)
        try:
            requests.post(cap, data=llsd.dump({"ack": ack, "done": True}), headers={"Content-Type": "application/llsd+xml"}, timeout=5)
        except Exception:
            pass

    def _eq_event(self, ev: Dict[str, Any]) -> None:
        name = ev.get("message")
        body = ev.get("body") or {}
        if name == "AgentGroupDataUpdate":
            groups = []
            for g in body.get("GroupData") or []:
                powers = g.get("GroupPowers", b"")
                groups.append(
                    {
                        "id": g.get("GroupID", ZERO_UUID),
                        "name": g.get("GroupName", "Group"),
                        "powers": str(int.from_bytes(powers, "big")) if isinstance(powers, bytes) else str(powers),
                        "accept_notices": bool(g.get("AcceptNotices", False)),
                        "insignia_id": g.get("GroupInsigniaID", ZERO_UUID),
                        "contribution": int(g.get("Contribution", 0) or 0),
                    }
                )
            self._store_groups(groups)
        elif name == "ChatterBoxInvitation":
            im = (body.get("instantmessage") or {}).get("message_params") or {}
            from_id = im.get("from_id", ZERO_UUID)
            if from_id == self.agent_id:
                return
            sid = im.get("id", ZERO_UUID)
            self.group_sessions.add(sid)
            self._insert_chat("group", sid, body.get("session_name") or self._group_name(sid), im.get("from_name", "?"), from_id, im.get("message", ""))
        elif name in ("KickUser", "ForceLogout"):
            self.error = "logged out by grid"
            self.stop_requested = True
        else:
            self._event(f"eq: {name}")


# registry of live circuits keyed by GridLink session_id
CIRCUITS: Dict[str, Circuit] = {}
