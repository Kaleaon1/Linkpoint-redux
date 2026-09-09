// In-process replacement for the FastAPI router in backend/server.py: same
// paths, same request/response shapes, but every handler runs on-device
// against local-db.ts / login.ts / circuit.ts instead of Mongo + a live
// server process. src/api.ts's get()/post() call straight into this.
import { CIRCUITS } from "./circuit";
import { ApiError } from "./errors";
import { newId } from "./ids";
import { db, secureCreds } from "./local-db";
import {
  diagnostics as loginDiagnostics,
  loginGrid,
  loginOffline,
  logoutSession,
  md5,
  prettyName,
  reconnect,
  refreshFriendNames,
  resolveNames,
  searchResidents,
} from "./login";
import {
  nowIso,
  type ChatMessage,
  type Conversation,
  type Friend,
  type FriendRequestIn,
  type Grid,
  type Group,
  type InventoryFolder,
  type RadarAvatar,
  type RadarResponse,
  type SearchResult,
  type UnreadEntry,
} from "./types";

// ---------------------------------------------------------------------------
// query-string / path helpers
// ---------------------------------------------------------------------------
function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!qs) return out;
  for (const pair of qs.split("&")) {
    if (!pair) continue;
    const idx = pair.indexOf("=");
    const k = idx === -1 ? pair : pair.slice(0, idx);
    const v = idx === -1 ? "" : pair.slice(idx + 1);
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, "%20"));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function split(path: string): { pathname: string; q: Record<string, string> } {
  const idx = path.indexOf("?");
  const pathname = idx === -1 ? path : path.slice(0, idx);
  const qs = idx === -1 ? "" : path.slice(idx + 1);
  return { pathname, q: parseQuery(qs) };
}

function need(q: Record<string, string>, key: string): string {
  const v = q[key];
  if (v === undefined) throw new ApiError(422, `Missing query param: ${key}`);
  return v;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const pParts = pattern.split("/").filter(Boolean);
  const parts = pathname.split("/").filter(Boolean);
  if (pParts.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pParts.length; i++) {
    if (pParts[i].startsWith("{") && pParts[i].endsWith("}")) {
      params[pParts[i].slice(1, -1)] = decodeURIComponent(parts[i]);
    } else if (pParts[i] !== parts[i]) {
      return null;
    }
  }
  return params;
}

function dist3(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Friend requests (incoming FriendshipOffered IMs captured by the circuit)
// ---------------------------------------------------------------------------
async function friendRequestsList(sessionId: string): Promise<FriendRequestIn[]> {
  const docs = await db.friend_requests.find({ session_id: sessionId, status: "pending" });
  docs.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return docs.slice(0, 100) as FriendRequestIn[];
}

async function answerFriendRequest(sessionId: string, requestId: string, accept: boolean) {
  const sess = await db.sessions.findOne({ session_id: sessionId });
  if (!sess) throw new ApiError(404, "Session not found");
  const fr = await db.friend_requests.findOne({ session_id: sessionId, id: requestId, status: "pending" });
  if (!fr) throw new ApiError(404, "Request not found or already answered");
  if (sess.mode === "grid") {
    const circ = CIRCUITS.get(sessionId);
    if (!circ || !circ.connected) throw new ApiError(503, "Not connected to the sim - reconnect first");
    if (accept) circ.acceptFriendship(requestId, sess.calling_cards_folder || "00000000-0000-0000-0000-000000000000");
    else circ.declineFriendship(requestId);
  }
  if (accept) {
    await db.friends.updateOne(
      { session_id: sessionId, id: fr.from_id },
      {
        $set: {
          id: fr.from_id,
          name: fr.from_name,
          online: true,
          can_see_me_online: true,
          can_see_me_map: false,
          can_modify_my_objects: false,
        },
      },
      { upsert: true },
    );
  }
  await db.friend_requests.updateOne({ session_id: sessionId, id: requestId }, { $set: { status: accept ? "accepted" : "declined" } });
  await db.chat.insertOne({
    id: newId(),
    session_id: sessionId,
    channel: "local",
    scope: "local",
    scope_name: "Local Chat",
    sender: "System",
    sender_id: null,
    text: `You ${accept ? "accepted" : "declined"} ${fr.from_name}'s friendship offer`,
    ts: nowIso(),
    system: true,
  });
  return { ok: true, status: accept ? "accepted" : "declined", friend_id: fr.from_id };
}

// ---------------------------------------------------------------------------
// Radar: CoarseLocationUpdate gives every avatar in the region (x, y, z*4)
// ---------------------------------------------------------------------------
async function radar(sessionId: string): Promise<RadarResponse> {
  const sess = await db.sessions.findOne({ session_id: sessionId });
  if (!sess) throw new ApiError(404, "Session not found");
  const friendDocs = await db.friends.find({ session_id: sessionId });
  const friendIds = new Set(friendDocs.map((f) => f.id));

  if (sess.mode === "offline") {
    const me: [number, number, number] = [128, 128, 24];
    const mock: [string, number, number, number][] = [
      ["Ruth Resident", 131, 130, 24],
      ["Governor Linden", 120, 136, 24],
      ["Torley Linden", 142, 118, 28],
      ["Magnum Resident", 110, 150, 24],
      ["Philip Linden", 160, 100, 32],
    ];
    const avatars: RadarAvatar[] = mock.map(([n, x, y, z]) => ({
      id: md5(n),
      name: n,
      x,
      y,
      z,
      distance: dist3(me, [x, y, z]),
      is_friend: friendIds.has(md5(n)),
    }));
    avatars.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    return { region_name: "GridLink Sandbox", connected: true, my_position: [...me], updated_ago_s: 0, avatars };
  }

  const circ = CIRCUITS.get(sessionId);
  if (!circ) {
    return { region_name: sess.region_name ?? null, connected: false, my_position: null, updated_ago_s: null, avatars: [] };
  }

  const nearby = new Map(circ.nearby);
  const me = circ.myPos;
  const nearbyIds = Array.from(nearby.keys());
  const friendsHere = await db.friends.find({ session_id: sessionId, id: { $in: nearbyIds } });
  const names = new Map(friendsHere.map((f) => [f.id, f.name]));
  const unknown = nearbyIds.filter((a) => !names.has(a) && !circ.nameCache.has(a));
  const cap = (sess.caps || {}).GetDisplayNames;
  if (unknown.length && cap) {
    const recs = await resolveNames(cap, unknown);
    for (const [aid, rec] of Object.entries(recs)) circ.nameCache.set(aid, prettyName(rec, aid));
  }
  const avatars: RadarAvatar[] = [];
  for (const [aid, [x, y, z]] of nearby) {
    const distance = me ? dist3(me, [x, y, z]) : null;
    avatars.push({
      id: aid,
      name: names.get(aid) || circ.nameCache.get(aid) || `Resident ${aid.slice(0, 8)}`,
      x,
      y,
      z,
      distance,
      is_friend: friendIds.has(aid),
    });
  }
  avatars.sort((a, b) => {
    const an = a.distance === null ? 1 : 0;
    const bn = b.distance === null ? 1 : 0;
    if (an !== bn) return an - bn;
    return (a.distance ?? 0) - (b.distance ?? 0);
  });
  return {
    region_name: circ.regionName || sess.region_name || null,
    connected: circ.connected,
    my_position: me ? [...me] : null,
    updated_ago_s: circ.nearbyUpdated ? Math.round((Date.now() / 1000 - circ.nearbyUpdated) * 10) / 10 : null,
    avatars,
  };
}

// ---------------------------------------------------------------------------
// Unread counts per IM / group scope
// ---------------------------------------------------------------------------
async function chatUnread(sessionId: string): Promise<UnreadEntry[]> {
  const sess = await db.sessions.findOne({ session_id: sessionId });
  if (!sess) throw new ApiError(404, "Session not found");
  const markDocs = await db.read_marks.find({ session_id: sessionId });
  const marks = new Map<string, string>();
  for (const m of markDocs) marks.set(`${m.channel}|${m.scope}`, m.ts);

  const query: Record<string, any> = { session_id: sessionId, channel: { $in: ["im", "group"] }, system: false };
  if (sess.agent_id) query.sender_id = { $ne: sess.agent_id };
  else query.sender = { $ne: sess.avatar_name };

  const msgs = await db.chat.find(query);
  const counts = new Map<string, UnreadEntry>();
  for (const m of msgs) {
    const key = `${m.channel}|${m.scope}`;
    if (m.ts <= (marks.get(key) ?? "")) continue;
    let e = counts.get(key);
    if (!e) {
      e = { channel: m.channel, scope: m.scope, scope_name: m.scope_name ?? null, count: 0 };
      counts.set(key, e);
    }
    e.count += 1;
    e.scope_name = m.scope_name || e.scope_name;
  }
  return Array.from(counts.values());
}

async function chatMarkRead(body: { session_id: string; channel: string; scope: string }): Promise<{ ok: true }> {
  await db.read_marks.updateOne(
    { session_id: body.session_id, channel: body.channel, scope: body.scope },
    { $set: { ts: nowIso() } },
    { upsert: true },
  );
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Live sim-circuit state for a session (offline sessions report mode only)
// ---------------------------------------------------------------------------
async function status(sessionId: string): Promise<Record<string, any>> {
  const sess = await db.sessions.findOne({ session_id: sessionId });
  if (!sess) throw new ApiError(404, "Session not found");
  if (sess.mode === "offline") {
    return { mode: "offline", connected: true, can_reconnect: false, region_name: "GridLink Sandbox", avatar_name: sess.avatar_name };
  }
  const creds = await secureCreds.load(sessionId);
  const canReconnect = !!creds;
  const circ = CIRCUITS.get(sessionId);
  if (!circ) {
    return {
      mode: "grid",
      connected: false,
      closed: true,
      can_reconnect: canReconnect,
      error: "sim link lost (app restarted)",
      region_name: sess.region_name ?? null,
      avatar_name: sess.avatar_name,
    };
  }
  return { mode: "grid", avatar_name: sess.avatar_name, can_reconnect: canReconnect, ...circ.status() };
}

async function groupsList(sessionId: string): Promise<Group[]> {
  const docs = await db.groups.find({ session_id: sessionId });
  return (docs as Group[])
    .map((d) => ({ id: d.id, name: d.name, insignia_id: d.insignia_id ?? null, accept_notices: d.accept_notices }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function imConversations(sessionId: string): Promise<Conversation[]> {
  const docs = await db.chat.find({ session_id: sessionId, channel: "im" });
  docs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const byScope = new Map<string, Conversation>();
  for (const d of docs) {
    byScope.set(d.scope, { id: d.scope, name: d.scope_name || "Resident", last_ts: d.ts, last_text: d.text || "" });
  }
  return Array.from(byScope.values()).sort((a, b) => (a.last_ts < b.last_ts ? 1 : a.last_ts > b.last_ts ? -1 : 0));
}

async function searchResidentsEndpoint(sessionId: string, qRaw: string): Promise<SearchResult[]> {
  const q = qRaw.trim();
  if (q.length < 2) return [];
  const sess = await db.sessions.findOne({ session_id: sessionId });
  if (!sess) throw new ApiError(404, "Session not found");
  const friendDocs = await db.friends.find({ session_id: sessionId });
  const friendIds = new Set(friendDocs.map((f) => f.id));
  let hits: { id: string; name: string; username: string }[];
  if (sess.mode === "offline") {
    const pool = [
      "Ruth Resident",
      "Governor Linden",
      "Torley Linden",
      "Philip Linden",
      "Magnum Resident",
      "Oz Linden",
      "Ebbe Linden",
      "Rodvik Linden",
      "Grumpity Linden",
      "Patch Linden",
      "Vir Linden",
    ];
    const needle = q.toLowerCase();
    hits = pool.filter((n) => n.toLowerCase().includes(needle)).map((n) => ({ id: md5(n), name: n, username: n.toLowerCase().replace(/ /g, ".") }));
  } else {
    const cap = (sess.caps || {}).AvatarPickerSearch;
    if (!cap) throw new ApiError(400, "Resident search capability unavailable for this session");
    hits = await searchResidents(cap, q);
  }
  return hits.map((h) => ({ ...h, is_friend: friendIds.has(h.id) }));
}

async function friendsRequest(body: { session_id: string; agent_id: string; name?: string; message?: string }) {
  const sess = await db.sessions.findOne({ session_id: body.session_id });
  if (!sess) throw new ApiError(404, "Session not found");
  if (sess.mode === "offline") {
    await db.friends.updateOne(
      { session_id: body.session_id, id: body.agent_id },
      {
        $set: {
          id: body.agent_id,
          name: body.name || `Resident ${body.agent_id.slice(0, 8)}`,
          online: true,
          can_see_me_online: true,
          can_see_me_map: false,
          can_modify_my_objects: false,
        },
      },
      { upsert: true },
    );
    return { ok: true, delivered: "offline" };
  }
  const circ = CIRCUITS.get(body.session_id);
  if (!circ || !circ.connected) throw new ApiError(503, "Not connected to the sim - log in again");
  circ.requestFriendship(body.agent_id, body.message || "");
  await db.chat.insertOne({
    id: newId(),
    session_id: body.session_id,
    channel: "local",
    scope: "local",
    scope_name: "Local Chat",
    sender: "System",
    sender_id: null,
    text: `Friendship offered to ${body.name || body.agent_id}`,
    ts: nowIso(),
    system: true,
  });
  return { ok: true, delivered: "grid" };
}

async function friendsList(sessionId: string): Promise<Friend[]> {
  const docs = await db.friends.find({ session_id: sessionId });
  docs.sort((a, b) => {
    if (!!a.online !== !!b.online) return a.online ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
  return docs.slice(0, 5000) as Friend[];
}

async function inventoryList(sessionId: string): Promise<InventoryFolder[]> {
  const docs = await db.inventory.find({ session_id: sessionId });
  return docs.map((d) => ({ id: d.id, parent_id: d.parent_id ?? null, name: d.name, type: d.type, version: d.version }));
}

async function chatHistory(sessionId: string, channel: string, scope: string): Promise<ChatMessage[]> {
  const docs = await db.chat.find({ session_id: sessionId, channel, scope });
  docs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return docs.slice(0, 500) as ChatMessage[];
}

async function chatSend(body: {
  session_id: string;
  channel: "local" | "im" | "group";
  scope: string;
  scope_name?: string;
  text: string;
}): Promise<ChatMessage> {
  const session = await db.sessions.findOne({ session_id: body.session_id });
  if (!session) throw new ApiError(404, "Session not found");
  const text = (body.text || "").trim();
  if (!text) throw new ApiError(400, "Empty message");

  if (session.mode === "grid") {
    const circ = CIRCUITS.get(body.session_id);
    if (!circ || !circ.connected) throw new ApiError(503, "Not connected to the sim - log in again");
    if (body.channel === "local") circ.sendLocalChat(text);
    else if (body.channel === "im") circ.sendIm(body.scope, text);
    else circ.sendGroupIm(body.scope, text);
  }

  const msg: ChatMessage = {
    id: newId(),
    session_id: body.session_id,
    channel: body.channel,
    scope: body.scope,
    scope_name: body.scope_name || (body.channel === "local" ? "Local Chat" : null),
    sender: session.avatar_name,
    sender_id: session.agent_id ?? null,
    text,
    ts: nowIso(),
    system: false,
  };
  await db.chat.insertOne(msg);

  // Auto-append a simulated system echo on offline mode so channel feels alive.
  if (session.mode === "offline" && body.channel === "local") {
    await db.chat.insertOne({
      id: newId(),
      session_id: body.session_id,
      channel: "local",
      scope: "local",
      scope_name: "Local Chat",
      sender: "System",
      sender_id: null,
      text: "Local chat delivered on region 'GridLink Sandbox' (radius 20m).",
      ts: nowIso(),
      system: true,
    });
  }
  return msg;
}

// ---------------------------------------------------------------------------
// Dispatch — mirrors the old @api.get / @api.post routes
// ---------------------------------------------------------------------------
export async function routeGet<T>(path: string): Promise<T> {
  const { pathname, q } = split(path);
  if (pathname === "/friends") return friendsList(need(q, "session_id")) as unknown as T;
  if (pathname === "/status") return status(need(q, "session_id")) as unknown as T;
  if (pathname === "/friends/requests") return friendRequestsList(need(q, "session_id")) as unknown as T;
  if (pathname === "/chat/unread") return chatUnread(need(q, "session_id")) as unknown as T;
  if (pathname === "/groups") return groupsList(need(q, "session_id")) as unknown as T;
  if (pathname === "/im/conversations") return imConversations(need(q, "session_id")) as unknown as T;
  if (pathname === "/chat") return chatHistory(need(q, "session_id"), need(q, "channel"), q.scope ?? "local") as unknown as T;
  if (pathname === "/inventory") return inventoryList(need(q, "session_id")) as unknown as T;
  if (pathname === "/diagnostics") return loginDiagnostics((q.grid as Grid) || "agni") as unknown as T;
  if (pathname === "/radar") return radar(need(q, "session_id")) as unknown as T;
  if (pathname === "/search/residents") return searchResidentsEndpoint(need(q, "session_id"), q.q ?? "") as unknown as T;
  throw new ApiError(404, `Unknown route: GET ${pathname}`);
}

export async function routePost<T>(path: string, body: any): Promise<T> {
  const { pathname, q } = split(path);
  if (pathname === "/login/offline") return loginOffline(body?.avatar_name ?? "") as unknown as T;
  if (pathname === "/login/grid") return loginGrid(body) as unknown as T;
  if (pathname === "/reconnect") return reconnect(need(q, "session_id")) as unknown as T;
  if (pathname === "/logout") return logoutSession(need(q, "session_id")).then(() => ({ ok: true })) as unknown as T;
  if (pathname === "/friends/refresh_names") return refreshFriendNames(need(q, "session_id")) as unknown as T;
  if (pathname === "/chat/mark_read") return chatMarkRead(body) as unknown as T;
  if (pathname === "/chat/send") return chatSend(body) as unknown as T;
  if (pathname === "/friends/request") return friendsRequest(body) as unknown as T;

  const accept = matchPath("/friends/requests/{id}/accept", pathname);
  if (accept) return answerFriendRequest(need(q, "session_id"), accept.id, true) as unknown as T;
  const decline = matchPath("/friends/requests/{id}/decline", pathname);
  if (decline) return answerFriendRequest(need(q, "session_id"), decline.id, false) as unknown as T;

  throw new ApiError(404, `Unknown route: POST ${pathname}`);
}
