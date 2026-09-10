// LLUDP sim circuit for GridLink — runs entirely on-device (no backend).
//
// After the XML-RPC login we open the same UDP circuit a viewer does
// (UseCircuitCode -> CompleteAgentMovement -> AgentThrottle, then AgentUpdate
// keep-alives). That is what makes the sim treat us as "in world": it starts
// pushing OnlineNotification / OfflineNotification for friends,
// AgentGroupDataUpdate for our groups, ChatFromSimulator for local chat and
// ImprovedInstantMessage for IMs / group chat / friendship offers.
//
// Only the handful of messages a text communicator needs are hand-encoded
// here. Header is 6 bytes: flags, uint32 BE sequence, extra-header length.
// Body ints are little-endian; message ids are High (1 byte) / Medium (FF xx)
// / Low (FF FF xxxx) / Fixed (FF FF FF xx). ZEROCODED (0x80) bodies
// run-length-encode zero bytes.
//
// Group data and group chat invitations also arrive on the HTTP
// EventQueueGet capability, so a second loop long-polls that.
//
// TS port of backend/sl_circuit.py; see that file for the original.
import dgram from "react-native-udp";

import {
  Reader,
  type Bytes,
  bytesToHex,
  bytesToUuid,
  concatBytes,
  cstr,
  f32le,
  floatsLE,
  fixed,
  high,
  i32le,
  low,
  med,
  rstripNulls,
  splitMsgId,
  u32be,
  u32le,
  u8arr,
  uuidToBytes,
  utf8Decode,
  var1,
  var2,
  zeroDecode,
} from "./bytes";
import { db } from "./local-db";
import * as llsd from "./llsd";
import { newId } from "./ids";
import { nowIso, type ChatMessage, type Friend, type Group } from "./types";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// -- message ids --------------------------------------------------------
const MSG_START_PING = high(1);
const MSG_COMPLETE_PING = high(2);
const MSG_AGENT_UPDATE = high(4);
const MSG_COARSE_LOCATION = med(6);
const MSG_CHAT_FROM_SIM = low(139); // per the official message template: Low 139, not Medium
const MSG_USE_CIRCUIT = low(3);
const MSG_CHAT_FROM_VIEWER = low(80);
const MSG_AGENT_THROTTLE = low(81);
const MSG_REGION_HANDSHAKE = low(148);
const MSG_REGION_HANDSHAKE_REPLY = low(149);
const MSG_KICK_USER = low(163);
const MSG_ACCEPT_FRIENDSHIP = low(297);
const MSG_DECLINE_FRIENDSHIP = low(298);
const MSG_COMPLETE_MOVEMENT = low(249);
const MSG_MOVEMENT_COMPLETE = low(250);
const MSG_LOGOUT_REQUEST = low(252);
const MSG_LOGOUT_REPLY = low(253);
const MSG_IM = low(254);
const MSG_RETRIEVE_IMS = low(255);
const MSG_ONLINE = low(322);
const MSG_OFFLINE = low(323);
const MSG_GROUP_DATA = low(389);
const MSG_PACKET_ACK = fixed(0xfb);

const HEX = {
  PACKET_ACK: bytesToHex(MSG_PACKET_ACK),
  START_PING: bytesToHex(MSG_START_PING),
  REGION_HANDSHAKE: bytesToHex(MSG_REGION_HANDSHAKE),
  MOVEMENT_COMPLETE: bytesToHex(MSG_MOVEMENT_COMPLETE),
  COARSE_LOCATION: bytesToHex(MSG_COARSE_LOCATION),
  CHAT_FROM_SIM: bytesToHex(MSG_CHAT_FROM_SIM),
  IM: bytesToHex(MSG_IM),
  ONLINE: bytesToHex(MSG_ONLINE),
  OFFLINE: bytesToHex(MSG_OFFLINE),
  GROUP_DATA: bytesToHex(MSG_GROUP_DATA),
  KICK_USER: bytesToHex(MSG_KICK_USER),
  LOGOUT_REPLY: bytesToHex(MSG_LOGOUT_REPLY),
};

const FLAG_ZEROCODED = 0x80;
const FLAG_RELIABLE = 0x40;
const FLAG_RESENT = 0x20;
const FLAG_ACK = 0x10;

// ImprovedInstantMessage dialog codes
const IM_MESSAGE_FROM_AGENT = 0;
const IM_SESSION_GROUP_START = 15;
const IM_SESSION_SEND = 17;
const IM_MESSAGE_FROM_OBJECT = 19;
const IM_FRIENDSHIP_OFFERED = 38;
const IM_FRIENDSHIP_ACCEPTED = 39;
const IM_FRIENDSHIP_DECLINED = 40;
const IM_TYPING = [41, 42];

// ChatFromSimulator chat types we hide
const CHAT_TYPING = [4, 5];

/** Viewer convention: 1:1 IM session id = agent XOR agent. */
function imSessionId(a: string, b: string): string {
  const ab = uuidToBytes(a);
  const bb = uuidToBytes(b);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = ab[i] ^ bb[i];
  return bytesToUuid(out);
}

// react-native-udp's bundled .d.ts pulls in the npm "events" polyfill's
// EventEmitter, which itself ships no types, so TS can't see UdpSocket's
// inherited on()/close() etc. through it. Re-declare the slice we actually
// use and cast the module past its broken types once, here.
type RemoteInfo = { address: string; port: number };
interface UdpSocketT {
  bind(port: number, callback?: () => void): void;
  send(
    msg: Bytes,
    offset: number,
    length: number,
    port: number,
    address: string,
    callback?: (error?: Error) => void,
  ): void;
  close(callback?: () => void): void;
  on(event: "message", listener: (data: Bytes, rinfo: RemoteInfo) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
}
const dgramTyped = dgram as unknown as { createSocket(opts: { type: "udp4" | "udp6" }): UdpSocketT };

export type CircuitOpts = {
  sessionId: string;
  agentId: string;
  slSessionId: string;
  circuitCode: number;
  simIp: string;
  simPort: number;
  avatarName: string;
  caps: Record<string, string>;
};

export class Circuit {
  sessionId: string;
  agentId: string;
  slSessionId: string;
  circuitCode: number;
  simIp: string;
  simPort: number;
  avatarName: string;
  caps: Record<string, string>;

  private sock: UdpSocketT | null = null;
  private seq = 0;
  private unacked = new Map<number, { pkt: Bytes; sent: number; tries: number }>();
  private pendingAcks: number[] = [];
  private seen: number[] = [];
  private seenSet = new Set<number>();
  private groupSessions = new Set<string>();

  // radar: agent_id -> [x, y, z] from CoarseLocationUpdate; my own position too
  nearby = new Map<string, [number, number, number]>();
  myPos: [number, number, number] | null = null;
  nearbyUpdated = 0;
  nameCache = new Map<string, string>();

  private startedAt = Date.now() / 1000;
  private lastRx = 0;
  private lastAgentUpdate = 0;
  connected = false;
  closed = false;
  private stopRequested = false;
  error: string | null = null;
  regionName: string | null = null;
  rxPackets = 0;
  txPackets = 0;
  private eqPolls = 0;
  private events: string[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private eqStop = false;

  constructor(opts: CircuitOpts) {
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
    this.slSessionId = opts.slSessionId;
    this.circuitCode = opts.circuitCode;
    this.simIp = opts.simIp;
    this.simPort = opts.simPort;
    this.avatarName = opts.avatarName;
    this.caps = opts.caps || {};
  }

  // -- lifecycle ----------------------------------------------------------
  start(): void {
    const sock = dgramTyped.createSocket({ type: "udp4" });
    this.sock = sock;
    sock.on("message", (data: Bytes) => {
      try {
        this.handle(data);
      } catch (e) {
        this.eventLog(`packet handler error: ${e}`);
      }
    });
    sock.on("error", (err: Error) => {
      this.error = this.error ?? `socket error: ${err?.message ?? err}`;
    });
    sock.bind(0, () => {
      this.eventLog(`opening circuit to ${this.simIp}:${this.simPort}`);
      this.send(
        concatBytes(MSG_USE_CIRCUIT, u32le(this.circuitCode), uuidToBytes(this.slSessionId), uuidToBytes(this.agentId)),
        true,
      );
      this.send(
        concatBytes(MSG_COMPLETE_MOVEMENT, uuidToBytes(this.agentId), uuidToBytes(this.slSessionId), u32le(this.circuitCode)),
        true,
      );
      const throttles = floatsLE(100000, 20000, 4000, 4000, 120000, 20000, 20000);
      this.send(
        concatBytes(
          MSG_AGENT_THROTTLE,
          uuidToBytes(this.agentId),
          uuidToBytes(this.slSessionId),
          u32le(this.circuitCode),
          u32le(0),
          var1(throttles),
        ),
        true,
      );
      this.agentUpdate();
      this.tickTimer = setInterval(() => this.tick(), 250);
    });
    if (this.caps.EventQueueGet) {
      this.eqLoop();
    }
  }

  /** Force-close this circuit (e.g. a new login for the same session superseded it). */
  async stop(reason = "superseded"): Promise<void> {
    await this.shutdown(reason);
  }

  async logout(): Promise<void> {
    if (!this.closed) {
      try {
        this.send(concatBytes(MSG_LOGOUT_REQUEST, uuidToBytes(this.agentId), uuidToBytes(this.slSessionId)), true);
      } catch {
        // best-effort
      }
      await new Promise((res) => setTimeout(res, 300));
    }
    await this.shutdown("logout");
  }

  private async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.stopRequested = true;
    this.eqStop = true;
    this.error = this.error ?? reason;
    this.eventLog(`circuit closed: ${reason}`);
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    try {
      this.sock?.close();
    } catch {
      // ignore
    }
    try {
      await db.friends.updateMany({ session_id: this.sessionId }, { $set: { online: false } });
    } catch {
      // ignore
    }
  }

  status(): Record<string, any> {
    return {
      connected: this.connected,
      closed: this.closed,
      error: this.error,
      region_name: this.regionName,
      sim: `${this.simIp}:${this.simPort}`,
      uptime_s: Math.round((Date.now() / 1000 - this.startedAt) * 10) / 10,
      last_rx_age_s: this.lastRx ? Math.round((Date.now() / 1000 - this.lastRx) * 10) / 10 : null,
      rx_packets: this.rxPackets,
      tx_packets: this.txPackets,
      eq_polls: this.eqPolls,
      unacked: this.unacked.size,
      events: [...this.events],
    };
  }

  private eventLog(text: string): void {
    this.events.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
    if (this.events.length > 60) this.events.splice(0, this.events.length - 60);
  }

  // -- sending --------------------------------------------------------------
  private send(body: Bytes, reliable = false): void {
    if (this.closed || !this.sock) return;
    this.seq += 1;
    const seq = this.seq;
    const flags = reliable ? FLAG_RELIABLE : 0;
    const pkt = concatBytes(u8arr(flags), u32be(seq), u8arr(0), body);
    this.sock.send(pkt, 0, pkt.length, this.simPort, this.simIp, () => {});
    this.txPackets += 1;
    if (reliable) this.unacked.set(seq, { pkt, sent: Date.now() / 1000, tries: 0 });
  }

  private flushAcks(): void {
    const acks = this.pendingAcks.splice(0, 255);
    if (!acks.length) return;
    this.send(concatBytes(MSG_PACKET_ACK, u8arr(acks.length), ...acks.map((a) => u32le(a))));
  }

  private resend(): void {
    const now = Date.now() / 1000;
    for (const [seq, rec] of this.unacked) {
      if (now - rec.sent < 1.5) continue;
      if (rec.tries >= 5) {
        this.unacked.delete(seq);
        continue;
      }
      rec.sent = now;
      rec.tries += 1;
      try {
        const resent = concatBytes(u8arr(rec.pkt[0] | FLAG_RESENT), rec.pkt.slice(1));
        this.sock?.send(resent, 0, resent.length, this.simPort, this.simIp, () => {});
      } catch {
        // ignore
      }
    }
  }

  private tick(): void {
    const now = Date.now() / 1000;
    if (now - this.lastAgentUpdate > 1.0) this.agentUpdate();
    if (this.pendingAcks.length) this.flushAcks();
    this.resend();
    if (this.lastRx && now - this.lastRx > 90) {
      this.error = "sim timeout (no packets for 90s)";
      this.shutdown(this.error);
      return;
    }
    if (!this.lastRx && now - this.startedAt > 30) {
      this.error = "sim never answered (UDP blocked?)";
      this.shutdown(this.error);
    }
  }

  private agentUpdate(): void {
    const body = concatBytes(
      MSG_AGENT_UPDATE,
      uuidToBytes(this.agentId),
      uuidToBytes(this.slSessionId),
      floatsLE(0, 0, 0), // BodyRotation
      floatsLE(0, 0, 0), // HeadRotation
      u8arr(0), // State
      floatsLE(128, 128, 25), // CameraCenter
      floatsLE(1, 0, 0), // CameraAtAxis
      floatsLE(0, 1, 0), // CameraLeftAxis
      floatsLE(0, 0, 1), // CameraUpAxis
      f32le(64.0), // Far
      u32le(0), // ControlFlags
      u8arr(0), // Flags
    );
    this.send(body);
    this.lastAgentUpdate = Date.now() / 1000;
  }

  sendLocalChat(text: string, chatType = 1, channel = 0): void {
    const body = concatBytes(
      MSG_CHAT_FROM_VIEWER,
      uuidToBytes(this.agentId),
      uuidToBytes(this.slSessionId),
      var2(cstr(text)),
      u8arr(chatType),
      i32le(channel),
    );
    this.send(body, true);
  }

  sendIm(
    toId: string,
    text: string,
    dialog: number = IM_MESSAGE_FROM_AGENT,
    imId?: string,
    bucket: Bytes = new Uint8Array(0),
    fromGroup = false,
  ): void {
    const id = imId || imSessionId(this.agentId, toId);
    const body = concatBytes(
      MSG_IM,
      uuidToBytes(this.agentId),
      uuidToBytes(this.slSessionId),
      u8arr(fromGroup ? 1 : 0),
      uuidToBytes(toId),
      u32le(0), // ParentEstateID
      uuidToBytes(ZERO_UUID), // RegionID
      floatsLE(0, 0, 0), // Position
      u8arr(0), // Offline
      u8arr(dialog),
      uuidToBytes(id),
      u32le(0), // Timestamp
      var1(cstr(this.avatarName)),
      var2(cstr(text)),
      var2(bucket),
      u32le(0), // EstateBlock.EstateID (unused, kept for wire-format completeness)
      u8arr(0), // MetaData: 0-length variable block
    );
    this.send(body, true);
  }

  sendGroupIm(groupId: string, text: string): void {
    if (!this.groupSessions.has(groupId)) {
      this.sendIm(groupId, "", IM_SESSION_GROUP_START, groupId);
      this.groupSessions.add(groupId);
    }
    this.sendIm(groupId, text, IM_SESSION_SEND, groupId);
  }

  acceptFriendship(transactionId: string, callingCardFolder: string = ZERO_UUID): void {
    const body = concatBytes(
      MSG_ACCEPT_FRIENDSHIP,
      uuidToBytes(this.agentId),
      uuidToBytes(this.slSessionId),
      uuidToBytes(transactionId),
      u8arr(1),
      uuidToBytes(callingCardFolder),
    );
    this.send(body, true);
  }

  declineFriendship(transactionId: string): void {
    this.send(
      concatBytes(MSG_DECLINE_FRIENDSHIP, uuidToBytes(this.agentId), uuidToBytes(this.slSessionId), uuidToBytes(transactionId)),
      true,
    );
  }

  requestFriendship(agentId: string, message: string): void {
    this.sendIm(agentId, message || "Would you be my friend?", IM_FRIENDSHIP_OFFERED, newId());
  }

  // -- receive --------------------------------------------------------------
  private handle(data: Bytes): void {
    if (data.length < 7) return;
    this.lastRx = Date.now() / 1000;
    this.rxPackets += 1;
    const flags = data[0];
    let end = data.length;
    if (flags & FLAG_ACK) {
      const n = data[data.length - 1];
      end = data.length - 1 - 4 * n;
      for (let k = 0; k < n; k++) {
        const view = new DataView(data.buffer, data.byteOffset + end + 4 * k, 4);
        this.acked(view.getUint32(0, true));
      }
    }
    let body: Bytes = data.slice(6, end);
    const extra = data[5];
    if (flags & FLAG_ZEROCODED) body = zeroDecode(body);
    body = body.slice(extra);
    const seqView = new DataView(data.buffer, data.byteOffset + 1, 4);
    const seq = seqView.getUint32(0, false);
    if (flags & FLAG_RELIABLE) this.pendingAcks.push(seq);
    if (this.seenSet.has(seq)) return;
    if (this.seen.length >= 4000) {
      const old = this.seen.shift();
      if (old !== undefined) this.seenSet.delete(old);
    }
    this.seen.push(seq);
    this.seenSet.add(seq);
    if (!body.length) return;
    const [mid, payload] = splitMsgId(body);
    this.dispatch(bytesToHex(mid), payload);
  }

  private acked(seq: number): void {
    this.unacked.delete(seq);
  }

  private dispatch(midHex: string, p: Bytes): void {
    const r = new Reader(p);
    if (midHex === HEX.PACKET_ACK) {
      const n = r.u8();
      for (let i = 0; i < n; i++) this.acked(r.u32());
    } else if (midHex === HEX.START_PING) {
      const pingId = r.u8();
      this.send(concatBytes(MSG_COMPLETE_PING, u8arr(pingId)));
    } else if (midHex === HEX.REGION_HANDSHAKE) {
      r.u32(); // RegionFlags
      r.u8(); // SimAccess
      this.regionName = r.text1();
      this.eventLog(`region handshake: ${this.regionName}`);
      this.send(
        concatBytes(MSG_REGION_HANDSHAKE_REPLY, uuidToBytes(this.agentId), uuidToBytes(this.slSessionId), u32le(0)),
        true,
      );
      db.sessions.updateOne({ session_id: this.sessionId }, { $set: { region_name: this.regionName } }).catch(() => {});
    } else if (midHex === HEX.MOVEMENT_COMPLETE) {
      if (!this.connected) {
        this.connected = true;
        this.eventLog("agent movement complete - in world");
        this.send(concatBytes(MSG_RETRIEVE_IMS, uuidToBytes(this.agentId), uuidToBytes(this.slSessionId)), true);
      }
    } else if (midHex === HEX.COARSE_LOCATION) {
      const n = r.u8();
      const locs: [number, number, number][] = [];
      for (let i = 0; i < n; i++) locs.push([r.u8(), r.u8(), r.u8() * 4]);
      const you = r.b.length - r.i >= 2 ? new DataView(r.b.buffer, r.b.byteOffset + r.i, 2).getInt16(0, true) : -1;
      r.skip(4); // You, Prey (S16 each)
      const idCount = r.u8();
      const ids: string[] = [];
      for (let i = 0; i < idCount; i++) ids.push(r.uuid());
      const nearby = new Map<string, [number, number, number]>();
      ids.forEach((aid, idx) => {
        if (idx < locs.length) nearby.set(aid, locs[idx]);
      });
      if (you >= 0 && you < locs.length) {
        this.myPos = locs[you];
      } else if (nearby.has(this.agentId)) {
        this.myPos = nearby.get(this.agentId)!;
      }
      nearby.delete(this.agentId);
      this.nearby = nearby;
      this.nearbyUpdated = Date.now() / 1000;
    } else if (midHex === HEX.CHAT_FROM_SIM) {
      this.onChat(r);
    } else if (midHex === HEX.IM) {
      this.onIm(r);
    } else if (midHex === HEX.ONLINE || midHex === HEX.OFFLINE) {
      const online = midHex === HEX.ONLINE;
      const n = r.u8();
      const ids: string[] = [];
      for (let i = 0; i < n; i++) ids.push(r.uuid());
      if (ids.length) {
        db.friends.updateMany({ session_id: this.sessionId, id: { $in: ids } }, { $set: { online } }).catch(() => {});
        this.eventLog(`${online ? "online" : "offline"}: ${ids.length} friend(s)`);
      }
    } else if (midHex === HEX.GROUP_DATA) {
      r.uuid(); // AgentID
      const n = r.u8();
      const groups: Group[] = [];
      for (let i = 0; i < n; i++) {
        const gid = r.uuid();
        r.u64(); // GroupPowers (unused by the UI)
        const accept = r.u8();
        const insignia = r.uuid();
        r.s32(); // Contribution
        const name = r.text1();
        groups.push({ id: gid, name, insignia_id: insignia, accept_notices: !!accept });
      }
      this.storeGroups(groups);
    } else if (midHex === HEX.KICK_USER) {
      r.skip(6); // TargetIP + TargetPort
      r.uuid();
      r.uuid();
      const reason = r.text2();
      this.error = `kicked: ${reason}`;
      this.system(`Disconnected by grid: ${reason}`);
      this.shutdown(this.error);
    } else if (midHex === HEX.LOGOUT_REPLY) {
      this.shutdown("logout reply");
    }
  }

  // -- inbound handlers -------------------------------------------------------
  private onChat(r: Reader): void {
    const fromName = r.text1();
    const sourceId = r.uuid();
    r.uuid(); // OwnerID
    const sourceType = r.u8();
    const chatType = r.u8();
    r.u8(); // Audible
    r.skip(12); // Position
    const message = r.text2();
    if (CHAT_TYPING.includes(chatType) || !message) return;
    if (sourceId === this.agentId) return; // we already stored our own line when sending
    const prefix = chatType === 0 ? "whispers: " : chatType === 2 ? "shouts: " : "";
    this.insertChat("local", "local", "Local Chat", fromName, sourceId, prefix + message, sourceType === 0);
  }

  private onIm(r: Reader): void {
    const fromId = r.uuid();
    r.uuid(); // SessionID (sender's)
    const fromGroup = !!r.u8();
    r.uuid(); // ToAgentID
    r.u32(); // ParentEstateID
    r.uuid(); // RegionID
    r.skip(12); // Position
    r.u8(); // Offline
    const dialog = r.u8();
    const imId = r.uuid();
    r.u32(); // Timestamp
    const fromName = r.text1();
    const message = r.text2();
    const bucket = r.var2();
    if (IM_TYPING.includes(dialog)) return;
    if (fromId === this.agentId) return;
    if (fromId === ZERO_UUID) {
      this.system(`${fromName}: ${message}`); // grid/system notices (deliveries, etc.)
    } else if (dialog === IM_SESSION_SEND || fromGroup) {
      const groupName = utf8Decode(rstripNulls(bucket)) || null;
      this.groupName(imId).then((name) => {
        this.insertChat("group", imId, groupName || name, fromName, fromId, message);
      });
    } else if (dialog === IM_MESSAGE_FROM_AGENT || dialog === IM_MESSAGE_FROM_OBJECT) {
      this.insertChat("im", fromId, fromName, fromName, fromId, message);
    } else if (dialog === IM_FRIENDSHIP_OFFERED) {
      db.friend_requests
        .updateOne(
          { session_id: this.sessionId, id: imId },
          {
            $set: {
              id: imId,
              session_id: this.sessionId,
              from_id: fromId,
              from_name: fromName,
              message,
              ts: nowIso(),
              status: "pending",
            },
          },
          { upsert: true },
        )
        .catch(() => {});
      this.system(`${fromName} has offered you friendship: ${message || "(no message)"}`);
    } else if (dialog === IM_FRIENDSHIP_ACCEPTED) {
      const friend: Friend = {
        id: fromId,
        name: fromName,
        online: true,
        can_see_me_online: true,
        can_see_me_map: false,
        can_modify_my_objects: false,
      };
      db.friends
        .updateOne({ session_id: this.sessionId, id: fromId }, { $set: friend }, { upsert: true })
        .catch(() => {});
      this.system(`${fromName} accepted your friendship offer`);
    } else if (dialog === IM_FRIENDSHIP_DECLINED) {
      this.system(`${fromName} declined your friendship offer`);
    } else if (message) {
      this.system(`${fromName}: ${message}`);
    }
  }

  private async groupName(gid: string): Promise<string> {
    const doc = await db.groups.findOne({ session_id: this.sessionId, id: gid });
    return doc ? doc.name : "Group";
  }

  private storeGroups(groups: Group[]): void {
    if (!groups.length) return;
    for (const g of groups) {
      db.groups
        .updateOne({ session_id: this.sessionId, id: g.id }, { $set: { ...g, session_id: this.sessionId } }, { upsert: true })
        .catch(() => {});
    }
    this.eventLog(`groups: ${groups.length} received`);
  }

  private insertChat(
    channel: ChatMessage["channel"],
    scope: string,
    scopeName: string,
    sender: string,
    senderId: string,
    text: string,
    system = false,
  ): void {
    const msg: ChatMessage = {
      id: newId(),
      session_id: this.sessionId,
      channel,
      scope,
      scope_name: scopeName,
      sender,
      sender_id: senderId,
      text,
      ts: nowIso(),
      system,
    };
    db.chat.insertOne(msg).catch(() => {});
  }

  private system(text: string): void {
    this.eventLog(text);
    this.insertChat("local", "local", "Local Chat", "System", ZERO_UUID, text, true);
  }

  // -- event queue ------------------------------------------------------------
  private async eqLoop(): Promise<void> {
    const cap = this.caps.EventQueueGet;
    let ack: number | null = null;
    while (!this.closed && !this.eqStop) {
      let text: string | null = null;
      let status = 0;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 65000);
        try {
          const r = await fetch(cap, {
            method: "POST",
            headers: { "Content-Type": "application/llsd+xml" },
            body: llsd.dump({ ack, done: false }),
            signal: controller.signal,
          });
          status = r.status;
          text = await r.text();
        } finally {
          clearTimeout(timer);
        }
        this.eqPolls += 1;
      } catch {
        continue;
      }
      if (status === 502 || status === 499) continue; // long-poll timeout with no events
      if (status === 404) {
        this.eventLog("event queue gone (404)");
        return;
      }
      if (status !== 200) {
        await new Promise((res) => setTimeout(res, 2000));
        continue;
      }
      let doc: any;
      try {
        doc = llsd.parse(text || "") || {};
      } catch {
        continue;
      }
      ack = typeof doc.id === "number" ? doc.id : ack;
      for (const ev of doc.events || []) {
        try {
          this.eqEvent(ev);
        } catch {
          // ignore malformed event
        }
      }
    }
    try {
      await fetch(cap, {
        method: "POST",
        headers: { "Content-Type": "application/llsd+xml" },
        body: llsd.dump({ ack, done: true }),
      });
    } catch {
      // ignore
    }
  }

  private eqEvent(ev: any): void {
    const name = ev.message;
    const body = ev.body || {};
    if (name === "AgentGroupDataUpdate") {
      const groups: Group[] = (body.GroupData || []).map((g: any) => ({
        id: g.GroupID || ZERO_UUID,
        name: g.GroupName || "Group",
        accept_notices: !!g.AcceptNotices,
        insignia_id: g.GroupInsigniaID || ZERO_UUID,
      }));
      this.storeGroups(groups);
    } else if (name === "ChatterBoxInvitation") {
      const im = (body.instantmessage || {}).message_params || {};
      const fromId = im.from_id || ZERO_UUID;
      if (fromId === this.agentId) return;
      const sid = im.id || ZERO_UUID;
      this.groupSessions.add(sid);
      this.groupName(sid).then((fallback) => {
        this.insertChat("group", sid, body.session_name || fallback, im.from_name || "?", fromId, im.message || "");
      });
    } else if (name === "KickUser" || name === "ForceLogout") {
      this.error = "logged out by grid";
      this.shutdown(this.error);
    } else if (name) {
      this.eventLog(`eq: ${name}`);
    }
  }
}

// registry of live circuits keyed by GridLink session_id
export const CIRCUITS = new Map<string, Circuit>();
