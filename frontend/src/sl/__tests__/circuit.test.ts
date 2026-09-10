// Packet-dispatch tests for the LLUDP circuit. Field layouts here are built
// straight from the official Second Life message template (the same one
// circuit.ts's message IDs and field orders were cross-checked against), so
// this exercises the real wire format rather than guessed-at bytes.
import AsyncStorage from "@react-native-async-storage/async-storage";
import dgram from "react-native-udp";

import type { FakeUdpSocket } from "../../../__mocks__/react-native-udp";
import {
  concatBytes,
  cstr,
  floatsLE,
  i32le,
  low,
  med,
  type Bytes,
  u32be,
  u32le,
  u8arr,
  uuidToBytes,
  var1,
  var2,
} from "../bytes";
import { Circuit, CIRCUITS } from "../circuit";
import { db } from "../local-db";

const SID = "circuit-test-session";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SL_SESSION = "22222222-2222-2222-2222-222222222222";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// -- LLUDP wire-level test helpers ------------------------------------------
const FLAG_ACK = 0x10;

function i16le(n: number): Bytes {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n, true);
  return b;
}
function u64le(n: bigint): Bytes {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

let seqCounter = 100;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

/** Build a full LLUDP datagram: 6-byte header + msg id + payload (+ optional piggybacked acks). */
function buildPacket(msgId: Bytes, payload: Bytes, opts: { seq?: number; acks?: number[] } = {}): Bytes {
  const seq = opts.seq ?? nextSeq();
  let flags = 0;
  let trailing: Bytes = new Uint8Array(0);
  if (opts.acks?.length) {
    flags |= FLAG_ACK;
    trailing = concatBytes(...opts.acks.map((a) => u32le(a)), u8arr(opts.acks.length));
  }
  return concatBytes(u8arr(flags), u32be(seq), u8arr(0), msgId, payload, trailing);
}

function seqOf(pkt: Bytes): number {
  return new DataView(pkt.buffer, pkt.byteOffset + 1, 4).getUint32(0, false);
}

// -- message ids (rebuilt independently from bytes.ts, per the official spec) --
const MSG_REGION_HANDSHAKE = low(148);
const MSG_MOVEMENT_COMPLETE = low(250);
const MSG_CHAT_FROM_SIM = low(139);
const MSG_IM = low(254);
const MSG_COARSE_LOCATION = med(6);
const MSG_GROUP_DATA = low(389);
const MSG_ONLINE = low(322);
const MSG_OFFLINE = low(323);
const MSG_KICK_USER = low(163);
// Arbitrary id with no dispatch handler in circuit.ts — a side-effect-free
// carrier for testing the standalone piggybacked-ack mechanism in isolation.
const MSG_NOOP = low(60000);

// -- payload builders, one per message, matching message_template.msg -------
function regionHandshakePayload(name: string): Bytes {
  return concatBytes(u32le(0), u8arr(1), var1(cstr(name)));
}

function chatFromSimPayload(opts: { fromName: string; sourceId: string; sourceType?: number; chatType?: number; message: string }): Bytes {
  return concatBytes(
    var1(cstr(opts.fromName)),
    uuidToBytes(opts.sourceId),
    uuidToBytes(ZERO_UUID), // OwnerID
    u8arr(opts.sourceType ?? 1),
    u8arr(opts.chatType ?? 1),
    u8arr(1), // Audible
    floatsLE(0, 0, 0), // Position
    var2(cstr(opts.message)),
  );
}

function imPayload(opts: {
  fromId: string;
  fromGroup?: boolean;
  toId?: string;
  dialog: number;
  imId: string;
  fromName: string;
  message: string;
  bucket?: Bytes;
}): Bytes {
  return concatBytes(
    uuidToBytes(opts.fromId),
    uuidToBytes(ZERO_UUID), // sender's SessionID (unused by our parser)
    u8arr(opts.fromGroup ? 1 : 0),
    uuidToBytes(opts.toId ?? AGENT_ID),
    u32le(0), // ParentEstateID
    uuidToBytes(ZERO_UUID), // RegionID
    floatsLE(0, 0, 0), // Position
    u8arr(0), // Offline
    u8arr(opts.dialog),
    uuidToBytes(opts.imId),
    u32le(0), // Timestamp
    var1(cstr(opts.fromName)),
    var2(cstr(opts.message)),
    var2(opts.bucket ?? new Uint8Array(0)),
  );
}

function coarseLocationPayload(opts: { locs: [number, number, number][]; you: number; ids: string[] }): Bytes {
  const locBytes = concatBytes(u8arr(opts.locs.length), ...opts.locs.map(([x, y, z]) => u8arr(x, y, z / 4)));
  const youPrey = concatBytes(i16le(opts.you), i16le(-1));
  const idBytes = concatBytes(u8arr(opts.ids.length), ...opts.ids.map(uuidToBytes));
  return concatBytes(locBytes, youPrey, idBytes);
}

function groupDataPayload(opts: { agentId: string; groups: { id: string; name: string; accept?: boolean }[] }): Bytes {
  const groupBytes = opts.groups.map((g) =>
    concatBytes(
      uuidToBytes(g.id),
      u64le(0n), // GroupPowers
      u8arr(g.accept ? 1 : 0),
      uuidToBytes(ZERO_UUID), // GroupInsigniaID
      i32le(0), // Contribution
      var1(cstr(g.name)),
    ),
  );
  return concatBytes(uuidToBytes(opts.agentId), u8arr(opts.groups.length), ...groupBytes);
}

function idsListPayload(ids: string[]): Bytes {
  return concatBytes(u8arr(ids.length), ...ids.map(uuidToBytes));
}

// -- test setup ---------------------------------------------------------
let circuit: Circuit;
let socket: FakeUdpSocket;

beforeEach(async () => {
  await AsyncStorage.clear();
  db.__resetForTests();
  seqCounter = 100;

  circuit = new Circuit({
    sessionId: SID,
    agentId: AGENT_ID,
    slSessionId: SL_SESSION,
    circuitCode: 123456,
    simIp: "1.2.3.4",
    simPort: 13005,
    avatarName: "Kaleaon Resident",
    caps: {}, // no EventQueueGet -> don't start the HTTP long-poll loop for these tests
  });
  circuit.start();
  socket = (dgram as any).__lastSocket;
  await Promise.resolve(); // let the bind() callback's initial handshake sends happen
});

afterEach(async () => {
  await circuit.stop("test cleanup");
  CIRCUITS.clear();
});

/** Drain pending promise chains (some dispatch handlers await a db read before writing). */
async function flush() {
  await new Promise((res) => setTimeout(res, 0));
}

describe("region handshake / movement", () => {
  test("RegionHandshake sets regionName and replies with RegionHandshakeReply", async () => {
    const before = socket.sent.length;
    socket.__emit("message", buildPacket(MSG_REGION_HANDSHAKE, regionHandshakePayload("Arapaima")));
    expect(circuit.regionName).toBe("Arapaima");
    expect(socket.sent.length).toBe(before + 1); // the reply
  });

  test("MovementComplete flips connected to true", () => {
    expect(circuit.connected).toBe(false);
    socket.__emit("message", buildPacket(MSG_MOVEMENT_COMPLETE, new Uint8Array(0)));
    expect(circuit.connected).toBe(true);
  });
});

describe("chat", () => {
  test("ChatFromSimulator inserts a local chat row", async () => {
    socket.__emit(
      "message",
      buildPacket(MSG_CHAT_FROM_SIM, chatFromSimPayload({ fromName: "Ruth Resident", sourceId: "33333333-3333-3333-3333-333333333333", message: "hello!" })),
    );
    await flush();
    const rows = await db.chat.find({ session_id: SID, channel: "local" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sender: "Ruth Resident", text: "hello!" });
  });

  test("whisper/shout chat types get a text prefix", async () => {
    socket.__emit(
      "message",
      buildPacket(MSG_CHAT_FROM_SIM, chatFromSimPayload({ fromName: "Ruth", sourceId: "33333333-3333-3333-3333-333333333333", chatType: 0, message: "psst" })),
    );
    await flush();
    const rows = await db.chat.find({ session_id: SID, channel: "local" });
    expect(rows[0].text).toBe("whispers: psst");
  });

  test("ignores our own echoed chat", async () => {
    socket.__emit("message", buildPacket(MSG_CHAT_FROM_SIM, chatFromSimPayload({ fromName: "Kaleaon Resident", sourceId: AGENT_ID, message: "hi" })));
    await flush();
    expect(await db.chat.find({ session_id: SID, channel: "local" })).toHaveLength(0);
  });

  test("ignores typing indicator chat types even with a non-empty body", async () => {
    socket.__emit(
      "message",
      buildPacket(MSG_CHAT_FROM_SIM, chatFromSimPayload({ fromName: "Ruth", sourceId: "33333333-3333-3333-3333-333333333333", chatType: 4, message: "typing" })),
    );
    await flush();
    expect(await db.chat.find({ session_id: SID, channel: "local" })).toHaveLength(0);
  });
});

describe("instant messages", () => {
  const SENDER = "33333333-3333-3333-3333-333333333333";

  test("a direct IM inserts a chat row scoped to the sender", async () => {
    socket.__emit(
      "message",
      buildPacket(MSG_IM, imPayload({ fromId: SENDER, dialog: 0, imId: "44444444-4444-4444-4444-444444444444", fromName: "Ruth Resident", message: "hey" })),
    );
    await flush();
    const rows = await db.chat.find({ session_id: SID, channel: "im", scope: SENDER });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sender: "Ruth Resident", text: "hey" });
  });

  test("a group IM with a bucket name inserts a chat row using that group name", async () => {
    const groupId = "55555555-5555-5555-5555-555555555555";
    socket.__emit(
      "message",
      buildPacket(
        MSG_IM,
        imPayload({
          fromId: SENDER,
          fromGroup: true,
          dialog: 17, // IM_SESSION_SEND
          imId: groupId,
          fromName: "Ruth Resident",
          message: "group hello",
          bucket: cstr("The Sandbox"),
        }),
      ),
    );
    await flush();
    const rows = await db.chat.find({ session_id: SID, channel: "group", scope: groupId });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope_name: "The Sandbox", sender: "Ruth Resident", text: "group hello" });
  });

  test("a FriendshipOffered IM creates a pending friend request", async () => {
    socket.__emit(
      "message",
      buildPacket(
        MSG_IM,
        imPayload({ fromId: SENDER, dialog: 38 /* IM_FRIENDSHIP_OFFERED */, imId: "66666666-6666-6666-6666-666666666666", fromName: "Ruth Resident", message: "add me?" }),
      ),
    );
    await flush();
    const reqs = await db.friend_requests.find({ session_id: SID, status: "pending" });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ from_id: SENDER, from_name: "Ruth Resident", message: "add me?" });
  });
});

describe("presence", () => {
  const FRIEND_A = "33333333-3333-3333-3333-333333333333";
  const FRIEND_B = "77777777-7777-7777-7777-777777777777";

  beforeEach(async () => {
    await db.friends.insertMany([
      { session_id: SID, id: FRIEND_A, name: "Ruth", online: false },
      { session_id: SID, id: FRIEND_B, name: "Governor", online: false },
    ]);
  });

  test("OnlineNotification flips listed friends online", async () => {
    socket.__emit("message", buildPacket(MSG_ONLINE, idsListPayload([FRIEND_A, FRIEND_B])));
    await flush();
    const friends = await db.friends.find({ session_id: SID });
    expect(friends.every((f: any) => f.online)).toBe(true);
  });

  test("OfflineNotification flips only the listed friend offline", async () => {
    await db.friends.updateMany({ session_id: SID }, { $set: { online: true } });
    socket.__emit("message", buildPacket(MSG_OFFLINE, idsListPayload([FRIEND_A])));
    await flush();
    expect((await db.friends.findOne({ session_id: SID, id: FRIEND_A }))?.online).toBe(false);
    expect((await db.friends.findOne({ session_id: SID, id: FRIEND_B }))?.online).toBe(true);
  });
});

describe("radar (CoarseLocationUpdate)", () => {
  test("populates nearby avatars and my own position, excluding myself from nearby", async () => {
    const friendId = "33333333-3333-3333-3333-333333333333";
    socket.__emit(
      "message",
      buildPacket(
        MSG_COARSE_LOCATION,
        coarseLocationPayload({
          locs: [
            [128, 128, 24], // me, z=24 -> byte 6 -> decodes back to 6*4=24
            [140, 120, 28],
          ],
          you: 0,
          ids: [AGENT_ID, friendId],
        }),
      ),
    );
    expect(circuit.myPos).toEqual([128, 128, 24]);
    expect(circuit.nearby.has(AGENT_ID)).toBe(false);
    expect(circuit.nearby.get(friendId)).toEqual([140, 120, 28]);
  });
});

describe("groups", () => {
  test("AgentGroupDataUpdate over UDP upserts groups", async () => {
    socket.__emit(
      "message",
      buildPacket(MSG_GROUP_DATA, groupDataPayload({ agentId: AGENT_ID, groups: [{ id: "88888888-8888-8888-8888-888888888888", name: "The Sandbox", accept: true }] })),
    );
    await flush();
    const groups = await db.groups.find({ session_id: SID });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: "The Sandbox", accept_notices: true });
  });
});

describe("reliability / dedup", () => {
  test("a repeated sequence number is only processed once", async () => {
    const seq = nextSeq();
    const pkt = buildPacket(MSG_CHAT_FROM_SIM, chatFromSimPayload({ fromName: "Ruth", sourceId: "33333333-3333-3333-3333-333333333333", message: "once" }), { seq });
    socket.__emit("message", pkt);
    socket.__emit("message", pkt); // simulate a UDP-level retransmit / duplicate
    await flush();
    expect(await db.chat.find({ session_id: SID, channel: "local" })).toHaveLength(1);
  });

  test("acking a reliable send removes it from the unacked set", async () => {
    const before = circuit.status().unacked;
    circuit.sendLocalChat("hi there");
    const sentPkt = socket.sent[socket.sent.length - 1].msg;
    expect(circuit.status().unacked).toBe(before + 1);

    const seq = seqOf(sentPkt);
    socket.__emit("message", buildPacket(MSG_NOOP, new Uint8Array(0), { acks: [seq] }));
    expect(circuit.status().unacked).toBe(before);
  });
});

describe("KickUser", () => {
  test("closes the circuit with the kick reason", async () => {
    const payload = concatBytes(
      new Uint8Array(6), // TargetIP + TargetPort
      uuidToBytes(ZERO_UUID),
      uuidToBytes(ZERO_UUID),
      var2(cstr("removed by an estate manager")),
    );
    socket.__emit("message", buildPacket(MSG_KICK_USER, payload));
    await flush();
    expect(circuit.closed).toBe(true);
    expect(circuit.error).toContain("removed by an estate manager");
  });
});
