import { decodeXmlEntities, escapeXml, findChild, parseXml } from "../xml-lite";

describe("escapeXml / decodeXmlEntities round-trip", () => {
  test.each(["<hello & \"world\" 'x'>", "no special chars", ""])("round-trips %p", (s) => {
    expect(decodeXmlEntities(escapeXml(s))).toBe(s);
  });

  test("decodes numeric and hex character references", () => {
    expect(decodeXmlEntities("&#65;&#x42;")).toBe("AB");
  });

  test("leaves an unknown entity name untouched", () => {
    expect(decodeXmlEntities("&nbsp;")).toBe("&nbsp;");
  });
});

describe("parseXml", () => {
  test("parses a simple element with text", () => {
    const root = parseXml("<root>hello</root>");
    expect(root).toEqual({ tag: "root", attrs: {}, children: [], text: "hello" });
  });

  test("parses nested elements and preserves order", () => {
    const root = parseXml("<a><b>1</b><c>2</c></a>");
    expect(root?.tag).toBe("a");
    expect(root?.children.map((c) => c.tag)).toEqual(["b", "c"]);
    expect(root?.children[0].text).toBe("1");
    expect(root?.children[1].text).toBe("2");
  });

  test("parses self-closing elements", () => {
    const root = parseXml("<undef/>");
    expect(root).toEqual({ tag: "undef", attrs: {}, children: [], text: "" });
  });

  test("parses attributes with entity-escaped values", () => {
    const root = parseXml('<x a="1" b=\'&amp;&lt;\'></x>');
    expect(root?.attrs).toEqual({ a: "1", b: "&<" });
  });

  test("decodes entities in text content", () => {
    const root = parseXml("<x>a &amp; b &lt;c&gt;</x>");
    expect(root?.text).toBe("a & b <c>");
  });

  test("skips the XML prolog and comments", () => {
    const root = parseXml('<?xml version="1.0" ?><!-- a comment --><root>ok</root>');
    expect(root?.tag).toBe("root");
    expect(root?.text).toBe("ok");
  });

  test("supports CDATA sections", () => {
    const root = parseXml("<x><![CDATA[<raw> & unescaped]]></x>");
    expect(root?.text).toBe("<raw> & unescaped");
  });

  test("findChild locates the first matching child tag", () => {
    const root = parseXml("<map><key>a</key><integer>1</integer><key>b</key></map>")!;
    expect(findChild(root, "key")?.text).toBe("a");
    expect(findChild(root, "integer")?.text).toBe("1");
    expect(findChild(root, "missing")).toBeUndefined();
  });

  test("returns null for empty input", () => {
    expect(parseXml("")).toBeNull();
  });

  test("round-trips an LLSD-shaped map/array structure", () => {
    const xml =
      '<?xml version="1.0" ?><llsd><map>' +
      "<key>name</key><string>Ruth Resident</string>" +
      "<key>tags</key><array><string>a</string><string>b</string></array>" +
      "</map></llsd>";
    const root = parseXml(xml)!;
    const map = root.children[0];
    expect(map.tag).toBe("map");
    const kids = map.children;
    expect(kids.map((k) => k.tag)).toEqual(["key", "string", "key", "array"]);
    expect(kids[3].children.map((c) => c.text)).toEqual(["a", "b"]);
  });
});
