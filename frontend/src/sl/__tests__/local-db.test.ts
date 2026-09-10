import AsyncStorage from "@react-native-async-storage/async-storage";

import { db, secureCreds } from "../local-db";

const SID = "session-a";
const OTHER_SID = "session-b";

beforeEach(async () => {
  await AsyncStorage.clear();
  // Collections cache their contents in memory after the first read, so
  // clearing AsyncStorage alone wouldn't be seen until this is called too.
  db.__resetForTests();
});

describe("Collection basic CRUD", () => {
  test("insertOne + findOne round-trip", async () => {
    await db.friends.insertOne({ session_id: SID, id: "f1", name: "Ruth", online: true });
    expect(await db.friends.findOne({ session_id: SID, id: "f1" })).toMatchObject({ name: "Ruth" });
    expect(await db.friends.findOne({ session_id: SID, id: "missing" })).toBeNull();
  });

  test("insertMany + find scoped by a plain-equality field", async () => {
    await db.friends.insertMany([
      { session_id: SID, id: "f1", name: "A" },
      { session_id: SID, id: "f2", name: "B" },
      { session_id: OTHER_SID, id: "f3", name: "C" },
    ]);
    const mine = await db.friends.find({ session_id: SID });
    expect(mine.map((f: any) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  test("updateOne with upsert:false does nothing when no match", async () => {
    await db.friends.updateOne({ session_id: SID, id: "nope" }, { $set: { name: "X" } });
    expect(await db.friends.find({ session_id: SID })).toHaveLength(0);
  });

  test("updateOne with upsert:true creates a new doc from the query + $set", async () => {
    await db.friends.updateOne({ session_id: SID, id: "f1" }, { $set: { name: "Ruth", online: true } }, { upsert: true });
    const doc = await db.friends.findOne({ session_id: SID, id: "f1" });
    expect(doc).toMatchObject({ session_id: SID, id: "f1", name: "Ruth", online: true });
  });

  test("updateOne merges $set into the existing doc rather than replacing it", async () => {
    await db.friends.insertOne({ session_id: SID, id: "f1", name: "Ruth", online: false, can_see_me_map: true });
    await db.friends.updateOne({ session_id: SID, id: "f1" }, { $set: { online: true } });
    const doc = await db.friends.findOne({ session_id: SID, id: "f1" });
    expect(doc).toMatchObject({ name: "Ruth", online: true, can_see_me_map: true });
  });

  test("updateMany sets a field on every matching doc", async () => {
    await db.friends.insertMany([
      { session_id: SID, id: "f1", online: false },
      { session_id: SID, id: "f2", online: false },
      { session_id: OTHER_SID, id: "f3", online: false },
    ]);
    await db.friends.updateMany({ session_id: SID }, { $set: { online: true } });
    expect((await db.friends.find({ session_id: SID })).every((f: any) => f.online)).toBe(true);
    expect((await db.friends.findOne({ session_id: OTHER_SID, id: "f3" }))?.online).toBe(false);
  });

  test("replaceOne with upsert replaces the whole document", async () => {
    await db.sessions.insertOne({ session_id: SID, avatar_name: "Old", extra: "keep-me-out" });
    await db.sessions.replaceOne({ session_id: SID }, { session_id: SID, avatar_name: "New" }, { upsert: true });
    const doc = await db.sessions.findOne({ session_id: SID });
    expect(doc).toEqual({ session_id: SID, avatar_name: "New" });
  });

  test("deleteMany removes only matching docs", async () => {
    await db.chat.insertMany([
      { session_id: SID, id: "c1" },
      { session_id: SID, id: "c2" },
      { session_id: OTHER_SID, id: "c3" },
    ]);
    await db.chat.deleteMany({ session_id: SID });
    expect(await db.chat.find({ session_id: SID })).toHaveLength(0);
    expect(await db.chat.find({ session_id: OTHER_SID })).toHaveLength(1);
  });

  test("a collection persists across a fresh read from AsyncStorage", async () => {
    await db.groups.insertOne({ session_id: SID, id: "g1", name: "Sandbox" });
    const raw = await AsyncStorage.getItem("gridlink.db.groups");
    expect(JSON.parse(raw!)).toEqual([{ session_id: SID, id: "g1", name: "Sandbox" }]);
  });
});

describe("query operators", () => {
  beforeEach(async () => {
    await db.chat.insertMany([
      { session_id: SID, channel: "im", sender_id: "a", text: "1" },
      { session_id: SID, channel: "group", sender_id: "b", text: "2" },
      { session_id: SID, channel: "local", sender_id: "a", text: "3" },
    ]);
  });

  test("$in matches any listed value", async () => {
    const docs = await db.chat.find({ session_id: SID, channel: { $in: ["im", "group"] } });
    expect(docs.map((d: any) => d.text).sort()).toEqual(["1", "2"]);
  });

  test("$nin excludes listed values", async () => {
    const docs = await db.chat.find({ session_id: SID, channel: { $nin: ["local"] } });
    expect(docs.map((d: any) => d.text).sort()).toEqual(["1", "2"]);
  });

  test("$ne excludes a single value", async () => {
    const docs = await db.chat.find({ session_id: SID, sender_id: { $ne: "a" } });
    expect(docs.map((d: any) => d.text)).toEqual(["2"]);
  });
});

describe("secureCreds", () => {
  test("save/load/clear round-trip, scoped per session", async () => {
    await secureCreds.save(SID, { first: "Kaleaon", last: "Resident", passwd_hash: "$1$abc", grid: "agni", start: "last" });
    expect(await secureCreds.load(SID)).toEqual({ first: "Kaleaon", last: "Resident", passwd_hash: "$1$abc", grid: "agni", start: "last" });
    expect(await secureCreds.load(OTHER_SID)).toBeNull();
    await secureCreds.clear(SID);
    expect(await secureCreds.load(SID)).toBeNull();
  });
});
