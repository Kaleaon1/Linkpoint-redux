import { parseXml } from "../xml-lite";
import { XmlRpcFault, buildRequest, call } from "../xmlrpc";

function mockFetchOnce(body: string, status = 200) {
  (global as any).fetch = jest.fn().mockResolvedValue({
    status,
    text: async () => body,
  });
}

describe("buildRequest", () => {
  test("wraps the method name and params, one <param> per value", () => {
    const xml = buildRequest("login_to_simulator", [{ first: "Ruth", last: "Resident" }]);
    const root = parseXml(xml)!;
    expect(root.tag).toBe("methodCall");
    expect(root.children.find((c) => c.tag === "methodName")?.text).toBe("login_to_simulator");
    const params = root.children.find((c) => c.tag === "params")!;
    expect(params.children).toHaveLength(1);
  });

  test.each([
    ["string", "hello", "string", "hello"],
    ["integer", 42, "int", "42"],
    ["double", 4.5, "double", "4.5"],
    ["boolean true", true, "boolean", "1"],
    ["boolean false", false, "boolean", "0"],
  ] as const)("encodes a %s param", (_label, value, tag, text) => {
    const xml = buildRequest("m", [value as any]);
    const root = parseXml(xml)!;
    const valueEl = root.children.find((c) => c.tag === "params")!.children[0].children[0];
    expect(valueEl.children[0].tag).toBe(tag);
    expect(valueEl.children[0].text).toBe(text);
  });

  test("encodes null as <nil/>", () => {
    const xml = buildRequest("m", [null]);
    expect(xml).toContain("<nil/>");
  });

  test("encodes an array param", () => {
    const xml = buildRequest("m", [["a", "b"]]);
    const root = parseXml(xml)!;
    const valueEl = root.children.find((c) => c.tag === "params")!.children[0].children[0];
    const arrayEl = valueEl.children[0];
    expect(arrayEl.tag).toBe("array");
    const dataEl = arrayEl.children.find((c) => c.tag === "data")!;
    expect(dataEl.children.map((v) => v.children[0].text)).toEqual(["a", "b"]);
  });

  test("encodes a struct param with nested members", () => {
    const xml = buildRequest("m", [{ options: ["buddy-list"], circuit_code: 1 }]);
    const root = parseXml(xml)!;
    const valueEl = root.children.find((c) => c.tag === "params")!.children[0].children[0];
    const structEl = valueEl.children[0];
    expect(structEl.tag).toBe("struct");
    const names = structEl.children.map((m) => m.children.find((c) => c.tag === "name")?.text);
    expect(names).toEqual(["options", "circuit_code"]);
  });

  test("escapes XML-sensitive characters in string params", () => {
    const xml = buildRequest("m", ["<a & b>"]);
    expect(xml).toContain("&lt;a &amp; b&gt;");
    expect(xml).not.toContain("<a & b>");
  });
});

describe("call", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("decodes a successful methodResponse struct", async () => {
    mockFetchOnce(
      '<?xml version="1.0"?><methodResponse><params><param><value><struct>' +
        "<member><name>login</name><value><string>true</string></value></member>" +
        "<member><name>agent_id</name><value><string>abc-123</string></value></member>" +
        "<member><name>circuit_code</name><value><int>12345</int></value></member>" +
        "<member><name>buddy-list</name><value><array><data>" +
        "<value><struct><member><name>buddy_id</name><value><string>u1</string></value></member></struct></value>" +
        "</data></array></value></member>" +
        "</struct></value></param></params></methodResponse>",
    );
    const result: any = await call("https://login.example/cgi-bin/login.cgi", "login_to_simulator", [{}]);
    expect(result.login).toBe("true");
    expect(result.agent_id).toBe("abc-123");
    expect(result.circuit_code).toBe(12345);
    expect(result["buddy-list"]).toEqual([{ buddy_id: "u1" }]);
  });

  test("throws XmlRpcFault with faultCode/faultString on a <fault> response", async () => {
    mockFetchOnce(
      '<?xml version="1.0"?><methodResponse><fault><value><struct>' +
        "<member><name>faultCode</name><value><int>-1</int></value></member>" +
        "<member><name>faultString</name><value><string>key</string></value></member>" +
        "</struct></value></fault></methodResponse>",
    );
    await expect(call("https://login.example/cgi-bin/login.cgi", "login_to_simulator", [{}])).rejects.toMatchObject(
      { faultCode: -1, faultString: "key" },
    );
    await expect(call("https://login.example/cgi-bin/login.cgi", "login_to_simulator", [{}])).rejects.toBeInstanceOf(
      XmlRpcFault,
    );
  });

  test("posts the built request body with an XML content type", async () => {
    mockFetchOnce("<methodResponse><params><param><value><string>ok</string></value></param></params></methodResponse>");
    await call("https://login.example/cgi-bin/login.cgi", "login_to_simulator", ["x"]);
    const [uri, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(uri).toBe("https://login.example/cgi-bin/login.cgi");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("text/xml");
    expect(opts.body).toContain("<methodName>login_to_simulator</methodName>");
  });
});
