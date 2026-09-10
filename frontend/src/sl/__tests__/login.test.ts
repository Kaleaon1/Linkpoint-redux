import dgram from "react-native-udp";

import { CIRCUITS } from "../circuit";
import * as llsd from "../llsd";
import {
  loginGrid,
  loginOffline,
  md5,
  prettyName,
  reconnect,
  type AgentRecord,
} from "../login";
import { db, secureCreds } from "../local-db";

// -- fixtures -----------------------------------------------------------
const LOGIN_URI = "https://login.agni.lindenlab.com/cgi-bin/login.cgi";
const SEED_CAP_URL = "https://sim.example/cap/seed";
const DISPLAY_NAMES_CAP_URL = "https://sim.example/cap/getdisplaynames";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const SL_SESSION = "22222222-2222-2222-2222-222222222222";
const BUDDY_ID = "33333333-3333-3333-3333-333333333333";

const AGENT_RECORDS: Record<string, AgentRecord> = {
  // Legacy left blank so prettyName resolves this to a plain "Kaleaon" (display-name-only branch).
  [AGENT_ID]: { username: "kaleaon.resident", display_name: "Kaleaon", legacy_first_name: "", legacy_last_name: "" },
  [BUDDY_ID]: { username: "ruth.resident", display_name: "", legacy_first_name: "Ruth", legacy_last_name: "Resident" },
};

function xrStr(s: string) {
  return `<value><string>${s}</string></value>`;
}
function xrInt(n: number) {
  return `<value><int>${n}</int></value>`;
}
function xrMember(name: string, valueXml: string) {
  return `<member><name>${name}</name>${valueXml}</member>`;
}
function xrArray(items: string[]) {
  return `<value><array><data>${items.join("")}</data></array></value>`;
}
function xrStruct(members: string[]) {
  return `<value><struct>${members.join("")}</struct></value>`;
}

function loginXmlRpcResponse(): string {
  const buddy = xrStruct([xrMember("buddy_id", xrStr(BUDDY_ID)), xrMember("buddy_rights_given", xrInt(1))]);
  const body = xrStruct([
    xrMember("login", xrStr("true")),
    xrMember("agent_id", xrStr(AGENT_ID)),
    xrMember("session_id", xrStr(SL_SESSION)),
    xrMember("first_name", xrStr("&quot;Kaleaon&quot;")),
    xrMember("last_name", xrStr("&quot;Resident&quot;")),
    xrMember("sim_ip", xrStr("1.2.3.4")),
    xrMember("sim_port", xrInt(13005)),
    xrMember("circuit_code", xrInt(123456)),
    xrMember("seed_capability", xrStr(SEED_CAP_URL)),
    xrMember("region_x", xrInt(256000)),
    xrMember("region_y", xrInt(256000)),
    xrMember("message", xrStr("Welcome to Second Life")),
    xrMember("buddy-list", xrArray([buddy])),
    xrMember("inventory-skeleton", xrArray([])),
  ]);
  return `<?xml version="1.0"?><methodResponse><params><param>${body}</param></params></methodResponse>`;
}

function loginFailureXmlRpcResponse(): string {
  const body = xrStruct([
    xrMember("login", xrStr("false")),
    xrMember("reason", xrStr("key")),
    xrMember("message", xrStr("Invalid login credentials")),
  ]);
  return `<?xml version="1.0"?><methodResponse><params><param>${body}</param></params></methodResponse>`;
}

function displayNamesResponseFor(url: string): string {
  const ids = Array.from(url.matchAll(/ids=([^&]+)/g)).map((m) => decodeURIComponent(m[1]));
  const agents = ids.filter((id) => AGENT_RECORDS[id]).map((id) => ({ id, ...AGENT_RECORDS[id] }));
  return llsd.dump({ agents });
}

function mockGridLoginFetch(loginXml: () => string = loginXmlRpcResponse) {
  (global as any).fetch = jest.fn(async (url: string) => {
    if (url === LOGIN_URI) return { status: 200, text: async () => loginXml() };
    if (url === SEED_CAP_URL) return { status: 200, text: async () => llsd.dump({ GetDisplayNames: DISPLAY_NAMES_CAP_URL }) };
    if (url.startsWith(DISPLAY_NAMES_CAP_URL)) return { status: 200, text: async () => displayNamesResponseFor(url) };
    throw new Error(`unmocked fetch: ${url}`);
  });
}

afterEach(async () => {
  // Grid-login tests start a real Circuit (backed by the react-native-udp
  // manual mock); stop it so it doesn't leave a background timer running
  // past the test.
  for (const circuit of Array.from(CIRCUITS.values())) {
    await circuit.stop("test cleanup");
  }
  CIRCUITS.clear();
  jest.restoreAllMocks();
});

describe("md5", () => {
  test("matches known MD5 test vectors", () => {
    expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5("password")).toBe("5f4dcc3b5aa765d61d8327deb882cf99");
  });
});

describe("prettyName", () => {
  const rec = (over: Partial<AgentRecord>): AgentRecord => ({
    username: "",
    display_name: "",
    legacy_first_name: "",
    legacy_last_name: "",
    ...over,
  });

  test("display name + legacy name, different: shows both", () => {
    expect(prettyName(rec({ display_name: "Kaleaon", legacy_first_name: "Ruth", legacy_last_name: "Resident" }), "u")).toBe(
      "Kaleaon (Ruth Resident)",
    );
  });

  test("display name equal to legacy (case-insensitive): shows once", () => {
    expect(prettyName(rec({ display_name: "Ruth Resident", legacy_first_name: "Ruth", legacy_last_name: "Resident" }), "u")).toBe(
      "Ruth Resident",
    );
  });

  test("display name only", () => {
    expect(prettyName(rec({ display_name: "Kaleaon" }), "u")).toBe("Kaleaon");
  });

  test("legacy name only", () => {
    expect(prettyName(rec({ legacy_first_name: "Ruth", legacy_last_name: "Resident" }), "u")).toBe("Ruth Resident");
  });

  test("username only", () => {
    expect(prettyName(rec({ username: "ruth.resident" }), "u")).toBe("ruth.resident");
  });

  test("falls back to a shortened UUID when nothing is present", () => {
    expect(prettyName(rec({}), "550e8400-e29b-41d4-a716-446655440000")).toBe("Resident 550e8400");
  });
});

describe("loginOffline", () => {
  test("seeds a full offline session (friends, inventory, groups, one pending request)", async () => {
    const resp = await loginOffline("  Test Avatar  ");
    expect(resp.ok).toBe(true);
    expect(resp.mode).toBe("offline");
    expect(resp.avatar_name).toBe("Test Avatar");
    expect(resp.friends_count).toBe(5);
    expect(resp.inventory_folders).toBe(12); // root + 11 default folders

    const friends = await db.friends.find({ session_id: resp.session_id });
    expect(friends).toHaveLength(5);
    const inventory = await db.inventory.find({ session_id: resp.session_id });
    expect(inventory.find((f: any) => f.parent_id === null)?.name).toBe("My Inventory");
    const requests = await db.friend_requests.find({ session_id: resp.session_id });
    expect(requests).toHaveLength(1);
    expect(requests[0].from_name).toBe("Oz Linden");
  });

  test("falls back to 'Anon Resident' for a blank name", async () => {
    const resp = await loginOffline("   ");
    expect(resp.avatar_name).toBe("Anon Resident");
  });
});

describe("loginGrid", () => {
  test("happy path: logs in, resolves display names, persists session/friends, starts a circuit", async () => {
    mockGridLoginFetch();
    const resp = await loginGrid({ first: "Kaleaon", last: "Resident", password: "hunter2", grid: "agni" });

    expect(resp.ok).toBe(true);
    expect(resp.mode).toBe("grid");
    expect(resp.agent_id).toBe(AGENT_ID);
    // Self display name resolved via GetDisplayNames, not the login response's quoted legacy name.
    expect(resp.avatar_name).toBe("Kaleaon");
    expect(resp.friends_count).toBe(1);

    const friends = await db.friends.find({ session_id: resp.session_id });
    expect(friends[0].name).toBe("Ruth Resident"); // display_name empty -> falls back to legacy
    expect(friends[0].can_see_me_online).toBe(true); // buddy_rights_given bit 0

    const sess = await db.sessions.findOne({ session_id: resp.session_id });
    expect(sess?.sim_ip).toBe("1.2.3.4");
    expect(sess?.caps.GetDisplayNames).toBe(DISPLAY_NAMES_CAP_URL);

    // A circuit was started for this session (its UDP socket is the manual mock).
    expect(CIRCUITS.has(resp.session_id)).toBe(true);
  });

  test("throws ApiError(401) with reason/message when the grid rejects the login", async () => {
    mockGridLoginFetch(loginFailureXmlRpcResponse);
    await expect(loginGrid({ first: "Kaleaon", last: "Resident", password: "wrong", grid: "agni" })).rejects.toMatchObject({
      status: 401,
      detail: { reason: "key", message: "Invalid login credentials" },
    });
  });

  test("graceful degradation: login still succeeds even if the UDP circuit fails to start", async () => {
    mockGridLoginFetch();
    const spy = jest.spyOn(dgram, "createSocket").mockImplementation(() => {
      throw new Error("UdpSockets native module not linked");
    });
    const resp = await loginGrid({ first: "Kaleaon", last: "Resident", password: "hunter2", grid: "agni" });
    expect(resp.ok).toBe(true);
    expect(resp.mode).toBe("grid");
    // The circuit was constructed and registered, but never actually started.
    expect(CIRCUITS.has(resp.session_id)).toBe(true);
    spy.mockRestore();
  });

  test("reconnect re-runs the handshake using stored credentials and keeps the session_id", async () => {
    mockGridLoginFetch();
    const first = await loginGrid({ first: "Kaleaon", last: "Resident", password: "hunter2", grid: "agni" });
    expect(await secureCreds.load(first.session_id)).not.toBeNull();

    const again = await reconnect(first.session_id);
    expect(again.session_id).toBe(first.session_id);
    expect(again.ok).toBe(true);
  });
});
