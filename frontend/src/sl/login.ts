// SL grid login handshake + capability resolution, ported from the
// _grid_login / login_offline / diagnostics endpoints in backend/server.py.
// Uses the same login handshake as the Firestorm viewer / libremetaverse:
// XML-RPC to https://login.<grid>.lindenlab.com/cgi-bin/login.cgi with a
// struct containing first, last, passwd ("$1$" + md5(password[:16])), start,
// channel, version, platform, mac (md5 hex), id0 (md5 hex), agree_to_tos,
// read_critical and options[] naming the response elements we want back
// (buddy-list, inventory-skeleton, gestures, etc.).
import CryptoJS from "crypto-js";

import { Circuit, CIRCUITS } from "./circuit";
import { ApiError } from "./errors";
import { newId } from "./ids";
import * as llsd from "./llsd";
import { db, secureCreds } from "./local-db";
import { nowIso, type Friend, type Grid, type Group, type InventoryFolder, type LoginResponse } from "./types";
import { call as xmlrpcCall, XmlRpcFault } from "./xmlrpc";

// ---------------------------------------------------------------------------
// Grid endpoints (Agni = main SL grid, Aditi = beta grid)
// ---------------------------------------------------------------------------
export const GRIDS: Record<Grid, { name: string; login_uri: string }> = {
  agni: { name: "Second Life (Agni)", login_uri: "https://login.agni.lindenlab.com/cgi-bin/login.cgi" },
  aditi: { name: "Second Life Beta (Aditi)", login_uri: "https://login.aditi.lindenlab.com/cgi-bin/login.cgi" },
};

export const VIEWER_CHANNEL = "GridLink Mobile";
export const VIEWER_VERSION = "1.0.0.0";
const VIEWER_PLATFORM = "Lin";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function md5(s: string): string {
  return CryptoJS.MD5(s).toString();
}

function slPassword(password: string): string {
  return "$1$" + md5(password.slice(0, 16));
}

/** Deterministic 32-char hex for mac/id0 so we don't leak the real device. */
function stableHex(seed: string): string {
  return md5(`gridlink::${seed}`);
}

function stripQuotes(s: string): string {
  return s.replace(/^"+/, "").replace(/"+$/, "");
}

// ---------------------------------------------------------------------------
// SL Display Name resolution.
// The XML-RPC login response's `buddy-list` only carries UUIDs and rights
// flags - no names. Names come from the `GetDisplayNames` capability which
// lives behind the login's `seed_capability`. Flow (per libremetaverse /
// Firestorm):
//   1. POST an LLSD array of wanted cap names to seed_capability
//   2. Response is an LLSD map of cap_name -> cap_url; grab GetDisplayNames
//   3. GET `${GetDisplayNames}?ids=uuid&ids=uuid&...` (batches <= 40)
//   4. Response is an LLSD map with `agents` array containing username /
//      display_name / legacy_first_name / legacy_last_name
// ---------------------------------------------------------------------------
const WANTED_CAPS = ["GetDisplayNames", "AvatarPickerSearch", "EventQueueGet", "ChatSessionRequest"];

async function fetchCaps(seedCap: string, names: string[]): Promise<Record<string, string>> {
  try {
    const r = await fetch(seedCap, {
      method: "POST",
      headers: { "Content-Type": "application/llsd+xml" },
      body: llsd.dump(names),
    });
    if (r.status !== 200) return {};
    const doc = llsd.parse(await r.text()) || {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(doc)) {
      if (typeof v === "string" && v.startsWith("http")) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function fetchDisplayNameCap(seedCap: string): Promise<string | undefined> {
  return (await fetchCaps(seedCap, ["GetDisplayNames"])).GetDisplayNames;
}

export type AgentRecord = { username: string; display_name: string; legacy_first_name: string; legacy_last_name: string };

function agentRecords(agents: any): Record<string, AgentRecord> {
  const out: Record<string, AgentRecord> = {};
  for (const a of agents || []) {
    if (!a || typeof a !== "object" || !a.id) continue;
    out[String(a.id).toLowerCase()] = {
      username: a.username || "",
      display_name: a.display_name || "",
      legacy_first_name: a.legacy_first_name || "",
      legacy_last_name: a.legacy_last_name || "",
    };
  }
  return out;
}

export async function resolveNames(displayNameCap: string, ids: string[]): Promise<Record<string, AgentRecord>> {
  const out: Record<string, AgentRecord> = {};
  if (!displayNameCap || !ids.length) return out;
  for (let i = 0; i < ids.length; i += 40) {
    const batch = ids.slice(i, i + 40);
    try {
      const sep = displayNameCap.includes("?") ? "&" : "?";
      const url = displayNameCap + sep + batch.map((x) => `ids=${encodeURIComponent(x)}`).join("&");
      const r = await fetch(url);
      if (r.status !== 200) continue;
      const doc = llsd.parse(await r.text()) || {};
      Object.assign(out, agentRecords(doc.agents));
    } catch {
      // skip this batch, keep going
    }
  }
  return out;
}

export async function searchResidents(cap: string, query: string): Promise<{ id: string; name: string; username: string }[]> {
  const sep = cap.includes("?") ? "&" : "?";
  const r = await fetch(`${cap}${sep}page_size=30&names=${encodeURIComponent(query)}`);
  if (r.status !== 200) throw new ApiError(502, `AvatarPickerSearch returned ${r.status}`);
  const doc = llsd.parse(await r.text()) || {};
  const recs = agentRecords(doc.agents);
  return Object.entries(recs).map(([id, rec]) => ({ id, name: prettyName(rec, id), username: rec.username }));
}

export function prettyName(rec: AgentRecord, uuidFallback: string): string {
  const display = (rec.display_name || "").trim();
  const lfirst = (rec.legacy_first_name || "").trim();
  const llast = (rec.legacy_last_name || "").trim();
  const legacy = `${lfirst} ${llast}`.trim();
  if (display && legacy && display.toLowerCase() !== legacy.toLowerCase()) return `${display} (${legacy})`;
  if (display) return display;
  if (legacy) return legacy;
  const username = (rec.username || "").trim();
  if (username) return username;
  return `Resident ${uuidFallback.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Offline demo data
// ---------------------------------------------------------------------------
function defaultInventory(): InventoryFolder[] {
  const root = newId();
  const base: InventoryFolder[] = [{ id: root, parent_id: null, name: "My Inventory", type: "root", version: 1 }];
  const folders = [
    "Textures",
    "Objects",
    "Clothing",
    "Body Parts",
    "Scripts",
    "Notecards",
    "Landmarks",
    "Sounds",
    "Animations",
    "Gestures",
    "Trash",
  ];
  for (const f of folders) {
    base.push({ id: newId(), parent_id: root, name: f, type: f.toLowerCase().replace(/ /g, "_"), version: 1 });
  }
  return base;
}

function defaultFriends(): Friend[] {
  const seed: [string, boolean][] = [
    ["Ruth Resident", true],
    ["Governor Linden", true],
    ["Torley Linden", false],
    ["Philip Linden", false],
    ["Magnum Resident", true],
  ];
  return seed.map(([name, online]) => ({
    id: md5(name),
    name,
    online,
    can_see_me_online: true,
    can_see_me_map: false,
    can_modify_my_objects: false,
  }));
}

function defaultGroups(): Group[] {
  return ["The Sandbox", "Firestorm Support", "Builders Guild"].map((n) => ({
    id: md5(`group::${n}`),
    name: n,
    insignia_id: null,
    accept_notices: true,
  }));
}

export async function loginOffline(avatarNameIn: string): Promise<LoginResponse> {
  const name = avatarNameIn.trim() || "Anon Resident";
  const sessionId = newId();
  const friends = defaultFriends();
  const inventory = defaultInventory();

  await db.sessions.insertOne({
    session_id: sessionId,
    mode: "offline",
    grid: "offline",
    avatar_name: name,
    created_at: nowIso(),
  });
  await db.friends.insertMany(friends.map((f) => ({ ...f, session_id: sessionId })));
  await db.inventory.insertMany(inventory.map((i) => ({ ...i, session_id: sessionId })));
  await db.groups.insertMany(defaultGroups().map((g) => ({ ...g, session_id: sessionId })));
  await db.friend_requests.insertOne({
    id: newId(),
    session_id: sessionId,
    from_id: md5("Oz Linden"),
    from_name: "Oz Linden",
    message: "Hey! Met you at the sandbox - add me?",
    ts: nowIso(),
    status: "pending",
  });

  return {
    ok: true,
    session_id: sessionId,
    mode: "offline",
    grid: "offline",
    avatar_name: name,
    friends_count: friends.length,
    inventory_folders: inventory.length,
    login_message: "Offline demo session. Chat is local-only.",
  };
}

// ---------------------------------------------------------------------------
// Grid login (shared by loginGrid / reconnect): XML-RPC login, roster/
// inventory sync into local storage under `session_id`, then open the sim
// circuit.
// ---------------------------------------------------------------------------
type GridLoginParams = {
  first: string;
  last: string;
  passwdHash: string;
  grid: Grid;
  start: string;
  agreeToTos: boolean;
  sessionId: string;
};

async function gridLogin(p: GridLoginParams): Promise<LoginResponse> {
  if (!(p.grid in GRIDS)) throw new ApiError(400, "Unknown grid");
  const loginUri = GRIDS[p.grid].login_uri;
  const first = p.first;
  const last = p.last || "Resident";

  const mac = stableHex(`mac::${first}::${last}`);
  const id0 = stableHex(`id0::${first}::${last}`);

  const payload = {
    first,
    last,
    passwd: p.passwdHash,
    start: p.start,
    channel: VIEWER_CHANNEL,
    version: VIEWER_VERSION,
    platform: VIEWER_PLATFORM,
    platform_string: "Linux",
    platform_version: "1.0.0",
    mac,
    id0,
    agree_to_tos: p.agreeToTos ? "true" : "false",
    read_critical: "true",
    viewer_digest: md5(VIEWER_CHANNEL + VIEWER_VERSION),
    address_size: 64,
    extended_errors: "true",
    host_id: "",
    mfa_hash: "",
    token: "",
    options: [
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
  };

  let resp: any;
  try {
    resp = await xmlrpcCall(loginUri, "login_to_simulator", [payload]);
  } catch (e: any) {
    throw new ApiError(502, `Grid unreachable: ${e?.message ?? e}`);
  }

  if (!resp || typeof resp !== "object" || resp.login !== "true") {
    const reason = resp && typeof resp === "object" ? resp.reason : "unknown";
    const message = resp && typeof resp === "object" ? resp.message : "Login failed";
    throw new ApiError(401, { reason, message });
  }

  // Parse response
  const agentId: string | undefined = resp.agent_id;
  const slSession: string | undefined = resp.session_id;
  const firstName = stripQuotes(String(resp.first_name ?? first));
  const lastName = stripQuotes(String(resp.last_name ?? last));
  let avatarName = `${firstName} ${lastName}`.trim();
  const simIp: string | undefined = resp.sim_ip;
  const simPort = resp.sim_port;
  const regionX = resp.region_x;
  const regionY = resp.region_y;
  const lookAt = resp.look_at;
  const seedCap: string | undefined = resp.seed_capability;
  const loginMsg = resp.message;
  const circuitCode = resp.circuit_code;

  // Buddy list -> friends. Presence is NOT in the login response; it arrives
  // as OnlineNotification over the sim circuit once we're in world.
  const buddies = Array.isArray(resp["buddy-list"]) ? resp["buddy-list"] : [];
  const friends: Friend[] = [];
  for (const b of buddies) {
    if (!b || typeof b !== "object") continue;
    const buddyId: string = b.buddy_id || newId();
    const rightsGiven = parseInt(String(b.buddy_rights_given ?? 0), 10) || 0;
    friends.push({
      id: buddyId,
      name: `Resident ${buddyId.slice(0, 8)}`,
      online: false,
      can_see_me_online: !!(rightsGiven & 1),
      can_see_me_map: !!(rightsGiven & 2),
      can_modify_my_objects: !!(rightsGiven & 4),
    });
  }

  // Capabilities: display names, resident search, event queue.
  let caps: Record<string, string> = {};
  if (seedCap) caps = await fetchCaps(String(seedCap), WANTED_CAPS);

  // Resolve display names via GetDisplayNames.
  const capUrl = caps.GetDisplayNames;
  if (capUrl && friends.length) {
    try {
      const ids = friends.map((f) => f.id);
      const names = await resolveNames(capUrl, ids);
      for (const f of friends) {
        const rec = names[f.id.toLowerCase()];
        if (rec) f.name = prettyName(rec, f.id);
      }
      // Refresh avatar_name from resolver too (display name > legacy)
      if (agentId) {
        let selfRec = names[String(agentId).toLowerCase()];
        if (!selfRec) {
          const extra = await resolveNames(capUrl, [String(agentId)]);
          selfRec = extra[String(agentId).toLowerCase()];
        }
        if (selfRec) avatarName = prettyName(selfRec, String(agentId));
      }
    } catch {
      // display-name resolution skipped
    }
  }

  // Inventory skeleton -> folders
  const skel = Array.isArray(resp["inventory-skeleton"]) ? resp["inventory-skeleton"] : [];
  let inventory: InventoryFolder[] = [];
  for (const f of skel) {
    if (!f || typeof f !== "object") continue;
    const parentId = f.parent_id;
    inventory.push({
      id: f.folder_id || newId(),
      parent_id: parentId && parentId !== "00000000-0000-0000-0000-000000000000" ? parentId : null,
      name: f.name || "Folder",
      type: String(f.type_default ?? "folder"),
      version: parseInt(String(f.version ?? 1), 10) || 1,
    });
  }
  if (!inventory.length) inventory = defaultInventory();

  const region = regionX !== undefined && regionX !== null ? `${regionX},${regionY}` : null;
  const callingCards = inventory.find((i) => i.type === "2")?.id ?? null;

  const sessionDoc = {
    session_id: p.sessionId,
    mode: "grid",
    grid: p.grid,
    avatar_name: avatarName,
    agent_id: agentId ?? null,
    sl_session_id: slSession ?? null,
    sim_ip: simIp ?? null,
    sim_port: simPort ?? null,
    region,
    look_at: lookAt !== undefined && lookAt !== null ? String(lookAt) : null,
    seed_capability: seedCap ?? null,
    caps,
    circuit_code: circuitCode ?? null,
    calling_cards_folder: callingCards,
    region_name: null as string | null,
    created_at: nowIso(),
  };
  // Reconnect re-uses the session_id so chat history survives; refresh roster & inventory.
  await db.sessions.replaceOne({ session_id: p.sessionId }, sessionDoc, { upsert: true });
  await secureCreds.save(p.sessionId, { first, last, passwd_hash: p.passwdHash, grid: p.grid, start: p.start });
  await db.friends.deleteMany({ session_id: p.sessionId });
  await db.inventory.deleteMany({ session_id: p.sessionId });
  if (friends.length) await db.friends.insertMany(friends.map((fr) => ({ ...fr, session_id: p.sessionId })));
  await db.inventory.insertMany(inventory.map((it) => ({ ...it, session_id: p.sessionId })));

  // Open the sim UDP circuit (presence, groups, chat, IMs).
  const old = CIRCUITS.get(p.sessionId);
  if (old) {
    CIRCUITS.delete(p.sessionId);
    await old.stop("superseded by new login");
  }
  if (agentId && slSession && circuitCode && simIp && simPort) {
    try {
      const circuit = new Circuit({
        sessionId: p.sessionId,
        agentId: String(agentId),
        slSessionId: String(slSession),
        circuitCode: Number(circuitCode),
        simIp: String(simIp),
        simPort: Number(simPort),
        avatarName,
        caps,
      });
      CIRCUITS.set(p.sessionId, circuit);
      circuit.start();
    } catch {
      // could not start sim circuit; UI surfaces this via /status
    }
  }

  return {
    ok: true,
    session_id: p.sessionId,
    mode: "grid",
    grid: p.grid,
    avatar_name: avatarName,
    agent_id: agentId ? String(agentId) : null,
    sl_session_id: slSession ? String(slSession) : null,
    sim_ip: simIp ? String(simIp) : null,
    sim_port: simPort ? Number(simPort) : null,
    region,
    look_at: lookAt !== undefined && lookAt !== null ? String(lookAt) : null,
    seed_capability: seedCap ? String(seedCap) : null,
    login_message: loginMsg ? String(loginMsg) : null,
    friends_count: friends.length,
    inventory_folders: inventory.length,
  };
}

export async function loginGrid(req: {
  first: string;
  last?: string;
  password: string;
  grid: Grid;
  start?: string;
  agree_to_tos?: boolean;
}): Promise<LoginResponse> {
  return gridLogin({
    first: req.first,
    last: req.last || "Resident",
    passwdHash: slPassword(req.password),
    grid: req.grid,
    start: req.start || "last",
    agreeToTos: req.agree_to_tos ?? true,
    sessionId: newId(),
  });
}

/** Re-run the grid handshake for an existing session whose circuit died
 * (app backgrounded/killed, sim timeout, kick). Keeps session_id + chat history. */
export async function reconnect(sessionId: string): Promise<LoginResponse> {
  const sess = await db.sessions.findOne({ session_id: sessionId });
  if (!sess) throw new ApiError(404, "Session not found");
  if (sess.mode === "offline") throw new ApiError(400, "Offline sessions have nothing to reconnect");
  const creds = await secureCreds.load(sessionId);
  if (!creds) throw new ApiError(400, "No stored login for this session - log in again");
  const circ = CIRCUITS.get(sessionId);
  if (circ && circ.connected && !circ.closed) {
    // Already live: tear it down first so SL releases the avatar's single circuit.
    await circ.logout();
    CIRCUITS.delete(sessionId);
    await new Promise((res) => setTimeout(res, 2000));
  }
  return gridLogin({
    first: creds.first,
    last: creds.last,
    passwdHash: creds.passwd_hash,
    grid: creds.grid,
    start: "last",
    agreeToTos: true,
    sessionId,
  });
}

export async function logoutSession(sessionId: string): Promise<void> {
  const circ = CIRCUITS.get(sessionId);
  if (circ) {
    CIRCUITS.delete(sessionId);
    await circ.logout();
  }
  await db.sessions.deleteMany({ session_id: sessionId });
  await db.friends.deleteMany({ session_id: sessionId });
  await db.inventory.deleteMany({ session_id: sessionId });
  await db.chat.deleteMany({ session_id: sessionId });
  await db.groups.deleteMany({ session_id: sessionId });
  await db.friend_requests.deleteMany({ session_id: sessionId });
  await db.read_marks.deleteMany({ session_id: sessionId });
  await secureCreds.clear(sessionId);
}

/** Re-resolve display names for every friend in a session using the stored
 * seed_capability. Useful when a session was created before name resolution
 * landed, or when a resident has since changed their display name. */
export async function refreshFriendNames(sessionId: string): Promise<{ updated: number; resolved: number }> {
  const sess = await db.sessions.findOne({ session_id: sessionId });
  if (!sess) throw new ApiError(404, "Session not found");
  const seed = sess.seed_capability;
  if (!seed) throw new ApiError(400, "Session has no seed capability (offline mode?)");
  const friends = await db.friends.find({ session_id: sessionId });
  if (!friends.length) return { updated: 0, resolved: 0 };
  const capUrl = await fetchDisplayNameCap(String(seed));
  if (!capUrl) throw new ApiError(502, "GetDisplayNames capability unavailable");
  const ids = friends.map((f) => f.id);
  if (sess.agent_id) ids.push(String(sess.agent_id));
  const names = await resolveNames(capUrl, ids);
  let updated = 0;
  for (const f of friends) {
    const rec = names[String(f.id).toLowerCase()];
    if (rec) {
      const newName = prettyName(rec, f.id);
      if (newName !== f.name) {
        await db.friends.updateOne({ session_id: sessionId, id: f.id }, { $set: { name: newName } });
        updated += 1;
      }
    }
  }
  if (sess.agent_id) {
    const selfRec = names[String(sess.agent_id).toLowerCase()];
    if (selfRec) {
      const newSelf = prettyName(selfRec, String(sess.agent_id));
      await db.sessions.updateOne({ session_id: sessionId }, { $set: { avatar_name: newSelf } });
    }
  }
  return { updated, resolved: Object.keys(names).length };
}

// ---------------------------------------------------------------------------
// Diagnostics — RN has no raw DNS/TCP socket API, so DNS+TCP+TLS reachability
// is approximated with a single HTTPS round trip to the login host; the XML-RPC
// latency probe (an intentionally-invalid login) is a direct port of server.py.
// ---------------------------------------------------------------------------
export async function diagnostics(grid: Grid) {
  if (!(grid in GRIDS)) throw new ApiError(400, "Unknown grid");
  const loginUri = GRIDS[grid].login_uri;
  const host = loginUri.split("//")[1].split("/")[0];

  let dnsOk = false;
  let reachable = false;
  let latencyMs: number | null = null;
  let serverTime: string | null = null;
  let error: string | null = null;

  const t0 = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(`https://${host}/`, { method: "HEAD", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    dnsOk = true;
    reachable = true;
  } catch (e: any) {
    error = `network: ${e?.message ?? e}`;
  }
  const roundTripMs = Date.now() - t0;

  if (reachable) {
    const t1 = Date.now();
    try {
      await xmlrpcCall(loginUri, "login_to_simulator", [
        {
          first: "grid",
          last: "check",
          passwd: slPassword("invalid"),
          start: "last",
          channel: VIEWER_CHANNEL,
          version: VIEWER_VERSION,
          platform: VIEWER_PLATFORM,
          mac: stableHex("diag-mac"),
          id0: stableHex("diag-id0"),
          agree_to_tos: "false",
          read_critical: "false",
          options: [],
        },
      ]);
      latencyMs = Date.now() - t1;
      serverTime = nowIso();
    } catch (e: any) {
      if (e instanceof XmlRpcFault) {
        latencyMs = Date.now() - t1;
        serverTime = nowIso();
        if (!error) error = `XML-RPC fault: ${e.faultString}`;
      } else if (!error) {
        error = `XML-RPC: ${e?.message ?? e}`;
      }
    }
  }

  return {
    grid,
    login_uri: loginUri,
    dns_ok: dnsOk,
    dns_ms: roundTripMs,
    reachable,
    tls_ms: roundTripMs,
    latency_ms: latencyMs,
    server_time: serverTime,
    viewer_channel: VIEWER_CHANNEL,
    viewer_version: VIEWER_VERSION,
    error,
  };
}
