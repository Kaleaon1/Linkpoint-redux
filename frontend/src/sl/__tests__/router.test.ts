// End-to-end tests for router.ts's routeGet/routePost — the REST-shaped
// contract every screen under frontend/app/ depends on via src/api.ts.
// Mostly exercised through offline-mode sessions (no network involved,
// closest thing to "just call the endpoint"); a couple of tests cover grid
// login wiring and error paths with a mocked fetch.
import AsyncStorage from "@react-native-async-storage/async-storage";

import { CIRCUITS } from "../circuit";
import * as llsd from "../llsd";
import { db } from "../local-db";
import { ApiError } from "../errors";
import { routeGet, routePost } from "../router";
import type { Diagnostics, FriendRequestIn, LoginResponse } from "../types";

beforeEach(async () => {
  await AsyncStorage.clear();
  db.__resetForTests();
});

afterEach(async () => {
  for (const circ of Array.from(CIRCUITS.values())) await circ.stop("test cleanup");
  CIRCUITS.clear();
  jest.restoreAllMocks();
});

async function offlineSession(name = "Test Avatar") {
  return routePost<LoginResponse>("/login/offline", { avatar_name: name });
}

describe("dispatch basics", () => {
  test("an unknown GET route throws a 404 ApiError", async () => {
    await expect(routeGet("/not/a/real/route")).rejects.toMatchObject({ status: 404 });
  });

  test("an unknown POST route throws a 404 ApiError", async () => {
    await expect(routePost("/not/a/real/route", {})).rejects.toMatchObject({ status: 404 });
  });

  test("a route requiring session_id throws 422 when it's missing", async () => {
    await expect(routeGet("/friends")).rejects.toMatchObject({ status: 422 });
  });
});

describe("offline session lifecycle", () => {
  test("POST /login/offline then GET /friends, /groups, /inventory", async () => {
    const sess = await offlineSession();
    const friends = await routeGet(`/friends?session_id=${sess.session_id}`);
    const groups = await routeGet(`/groups?session_id=${sess.session_id}`);
    const inventory = await routeGet(`/inventory?session_id=${sess.session_id}`);
    expect(friends).toHaveLength(5);
    expect((groups as any[]).map((g: any) => g.name)).toContain("The Sandbox");
    expect((inventory as any[]).find((f: any) => f.name === "My Inventory")).toBeTruthy();
  });

  test("GET /status reports offline mode as connected with no reconnect option", async () => {
    const sess = await offlineSession();
    const status: any = await routeGet(`/status?session_id=${sess.session_id}`);
    expect(status).toMatchObject({ mode: "offline", connected: true, can_reconnect: false });
  });

  test("GET /radar returns the 5 mock avatars sorted by distance", async () => {
    const sess = await offlineSession();
    const radar: any = await routeGet(`/radar?session_id=${sess.session_id}`);
    expect(radar.connected).toBe(true);
    expect(radar.avatars).toHaveLength(5);
    const distances = radar.avatars.map((a: any) => a.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  test("GET /search/residents matches the offline directory and flags friends", async () => {
    const sess = await offlineSession();
    const hits: any[] = await routeGet(`/search/residents?session_id=${sess.session_id}&q=linden`);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.name.toLowerCase().includes("linden"))).toBe(true);
  });

  test("GET /search/residents returns nothing for a too-short query", async () => {
    const sess = await offlineSession();
    expect(await routeGet(`/search/residents?session_id=${sess.session_id}&q=a`)).toEqual([]);
  });

  test("POST /friends/request adds a friend in offline mode", async () => {
    const sess = await offlineSession();
    const resp: any = await routePost("/friends/request", {
      session_id: sess.session_id,
      agent_id: "99999999-9999-9999-9999-999999999999",
      name: "New Friend",
    });
    expect(resp).toEqual({ ok: true, delivered: "offline" });
    const friends: any[] = await routeGet(`/friends?session_id=${sess.session_id}`);
    expect(friends.find((f: any) => f.name === "New Friend")).toBeTruthy();
  });
});

describe("friend requests", () => {
  test("GET /friends/requests lists the seeded Oz Linden offer, then accept updates status and adds a friend", async () => {
    const sess = await offlineSession();
    const reqs = await routeGet<FriendRequestIn[]>(`/friends/requests?session_id=${sess.session_id}`);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].from_name).toBe("Oz Linden");

    const result: any = await routePost(`/friends/requests/${reqs[0].id}/accept?session_id=${sess.session_id}`, {});
    expect(result).toMatchObject({ ok: true, status: "accepted" });

    expect(await routeGet(`/friends/requests?session_id=${sess.session_id}`)).toHaveLength(0);
    const friends: any[] = await routeGet(`/friends?session_id=${sess.session_id}`);
    expect(friends.find((f: any) => f.name === "Oz Linden")).toBeTruthy();
  });

  test("decline marks the request declined without adding a friend", async () => {
    const sess = await offlineSession();
    const reqs = await routeGet<FriendRequestIn[]>(`/friends/requests?session_id=${sess.session_id}`);
    await routePost(`/friends/requests/${reqs[0].id}/decline?session_id=${sess.session_id}`, {});
    expect(await routeGet(`/friends/requests?session_id=${sess.session_id}`)).toHaveLength(0);
    const friends: any[] = await routeGet(`/friends?session_id=${sess.session_id}`);
    expect(friends.find((f: any) => f.name === "Oz Linden")).toBeFalsy();
  });

  test("answering an already-answered request 404s", async () => {
    const sess = await offlineSession();
    const reqs = await routeGet<FriendRequestIn[]>(`/friends/requests?session_id=${sess.session_id}`);
    await routePost(`/friends/requests/${reqs[0].id}/accept?session_id=${sess.session_id}`, {});
    await expect(routePost(`/friends/requests/${reqs[0].id}/accept?session_id=${sess.session_id}`, {})).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("chat", () => {
  test("send + read local chat, with the offline system echo appended", async () => {
    const sess = await offlineSession();
    const sent: any = await routePost("/chat/send", { session_id: sess.session_id, channel: "local", scope: "local", text: "hello region" });
    expect(sent.text).toBe("hello region");

    const history: any[] = await routeGet(`/chat?session_id=${sess.session_id}&channel=local&scope=local`);
    expect(history).toHaveLength(2); // our message + the offline system echo
    expect(history[0].text).toBe("hello region");
    expect(history[1].system).toBe(true);
  });

  test("send rejects an empty message with 400", async () => {
    const sess = await offlineSession();
    await expect(routePost("/chat/send", { session_id: sess.session_id, channel: "local", scope: "local", text: "   " })).rejects.toMatchObject({
      status: 400,
    });
  });

  test("IM messages show up in /im/conversations", async () => {
    const sess = await offlineSession();
    const peer = "33333333-3333-3333-3333-333333333333";
    await routePost("/chat/send", { session_id: sess.session_id, channel: "im", scope: peer, scope_name: "Ruth Resident", text: "hi there" });
    const convs: any[] = await routeGet(`/im/conversations?session_id=${sess.session_id}`);
    expect(convs).toEqual([{ id: peer, name: "Ruth Resident", last_ts: expect.any(String), last_text: "hi there" }]);
  });

  test("unread counts increase on a new IM and clear after mark_read", async () => {
    const sess = await offlineSession();
    const peer = "33333333-3333-3333-3333-333333333333";
    // Simulate an incoming IM (not sent by us) directly, the way circuit.ts would insert one.
    await db.chat.insertOne({
      id: "msg-1",
      session_id: sess.session_id,
      channel: "im",
      scope: peer,
      scope_name: "Ruth Resident",
      sender: "Ruth Resident",
      sender_id: peer,
      text: "hey!",
      ts: new Date().toISOString(),
      system: false,
    });
    let unread: any[] = await routeGet(`/chat/unread?session_id=${sess.session_id}`);
    expect(unread).toEqual([{ channel: "im", scope: peer, scope_name: "Ruth Resident", count: 1 }]);

    await routePost("/chat/mark_read", { session_id: sess.session_id, channel: "im", scope: peer });
    unread = await routeGet(`/chat/unread?session_id=${sess.session_id}`);
    expect(unread).toHaveLength(0);
  });
});

describe("reconnect / logout", () => {
  test("reconnect on an offline session is rejected with 400", async () => {
    const sess = await offlineSession();
    await expect(routePost(`/reconnect?session_id=${sess.session_id}`, {})).rejects.toMatchObject({ status: 400 });
  });

  test("logout removes the session so subsequent reads report not-found", async () => {
    const sess = await offlineSession();
    await routePost(`/logout?session_id=${sess.session_id}`, {});
    await expect(routeGet(`/status?session_id=${sess.session_id}`)).rejects.toMatchObject({ status: 404 });
    expect(await routeGet(`/friends?session_id=${sess.session_id}`)).toEqual([]);
  });
});

describe("diagnostics", () => {
  test("GET /diagnostics reports reachable + latency when the grid answers", async () => {
    (global as any).fetch = jest.fn(async (url: string, opts: any) => {
      if (opts?.method === "HEAD") return { status: 200, text: async () => "" };
      // XML-RPC login probe: any well-formed methodResponse works for this test.
      return {
        status: 200,
        text: async () =>
          '<?xml version="1.0"?><methodResponse><params><param><value><struct>' +
          "<member><name>login</name><value><string>false</string></value></member>" +
          "<member><name>reason</name><value><string>key</string></value></member>" +
          "</struct></value></param></params></methodResponse>",
      };
    });
    const diag = await routeGet<Diagnostics>("/diagnostics?grid=agni");
    expect(diag.reachable).toBe(true);
    expect(diag.dns_ok).toBe(true);
    expect(diag.latency_ms).not.toBeNull();
  });

  test("GET /diagnostics reports unreachable when the network call rejects", async () => {
    (global as any).fetch = jest.fn().mockRejectedValue(new Error("network down"));
    const diag = await routeGet<Diagnostics>("/diagnostics?grid=agni");
    expect(diag.reachable).toBe(false);
    expect(diag.error).toContain("network down");
  });
});

describe("grid login route wiring", () => {
  const LOGIN_URI = "https://login.agni.lindenlab.com/cgi-bin/login.cgi";

  test("POST /login/grid surfaces a failed-login ApiError through the router", async () => {
    (global as any).fetch = jest.fn(async (url: string) => {
      if (url === LOGIN_URI) {
        return {
          status: 200,
          text: async () =>
            '<?xml version="1.0"?><methodResponse><params><param><value><struct>' +
            "<member><name>login</name><value><string>false</string></value></member>" +
            "<member><name>reason</name><value><string>key</string></value></member>" +
            "<member><name>message</name><value><string>Invalid login credentials</string></value></member>" +
            "</struct></value></param></params></methodResponse>",
        };
      }
      throw new Error(`unmocked fetch: ${url}`);
    });
    await expect(
      routePost("/login/grid", { first: "Kaleaon", last: "Resident", password: "wrong", grid: "agni" }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  test("GET /status for a grid session with no live circuit reports the app-restarted state", async () => {
    (global as any).fetch = jest.fn(async (url: string) => {
      if (url === LOGIN_URI) {
        const body =
          '<?xml version="1.0"?><methodResponse><params><param><value><struct>' +
          "<member><name>login</name><value><string>true</string></value></member>" +
          "<member><name>agent_id</name><value><string>11111111-1111-1111-1111-111111111111</string></value></member>" +
          "<member><name>session_id</name><value><string>22222222-2222-2222-2222-222222222222</string></value></member>" +
          "<member><name>circuit_code</name><value><int>1</int></value></member>" +
          "<member><name>sim_ip</name><value><string>1.2.3.4</string></value></member>" +
          "<member><name>sim_port</name><value><int>13005</int></value></member>" +
          "<member><name>buddy-list</name><value><array><data></data></array></value></member>" +
          "<member><name>inventory-skeleton</name><value><array><data></data></array></value></member>" +
          "</struct></value></param></params></methodResponse>";
        return { status: 200, text: async () => body };
      }
      return { status: 200, text: async () => llsd.dump({}) };
    });
    const login = await routePost<LoginResponse>("/login/grid", { first: "Kaleaon", last: "Resident", password: "x", grid: "agni" });
    // Tear down the live circuit the login just started, to simulate "app restarted".
    await CIRCUITS.get(login.session_id)!.stop("simulate restart");
    CIRCUITS.delete(login.session_id);

    const status: any = await routeGet(`/status?session_id=${login.session_id}`);
    expect(status).toMatchObject({ mode: "grid", connected: false, closed: true, can_reconnect: true });
  });
});
