import { LLSDReal, LLSDUUID, NULL_UUID, dump, parse } from "../llsd";

describe("llsd dump/parse round-trip", () => {
  test("round-trips a nested map/array structure", () => {
    const value = {
      name: "Ruth Resident",
      count: 3,
      active: true,
      tags: ["a", "b", "c"],
      nested: { x: 1, y: [true, false] },
    };
    expect(parse(dump(value))).toEqual(value);
  });

  test("dump emits <uuid> for LLSDUUID and it parses back to a plain string", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const xml = dump({ id: new LLSDUUID(id) });
    expect(xml).toContain(`<uuid>${id}</uuid>`);
    expect(parse(xml)).toEqual({ id });
  });

  test("dump emits <real> for LLSDReal and preserves a whole-number float", () => {
    const xml = dump({ v: new LLSDReal(1) });
    expect(xml).toContain("<real>1</real>");
    expect(parse(xml)).toEqual({ v: 1 });
  });

  test("integers and reals stay distinguishable in the XML", () => {
    expect(dump(5)).toContain("<integer>5</integer>");
    expect(dump(5.5)).toContain("<real>5.5</real>");
  });

  test("null/undefined dump to <undef/> and parse back to null", () => {
    expect(dump(null)).toContain("<undef/>");
    expect(parse(dump({ v: null }))).toEqual({ v: null });
  });

  test("booleans round-trip", () => {
    expect(parse(dump({ a: true, b: false }))).toEqual({ a: true, b: false });
  });

  test("an array at the top level round-trips", () => {
    expect(parse(dump(["x", "y", "z"]))).toEqual(["x", "y", "z"]);
  });

  test("a bare uuid element parses to a string, defaulting to NULL_UUID when empty", () => {
    expect(parse("<llsd><uuid></uuid></llsd>")).toBe(NULL_UUID);
  });

  test("escapes special characters in strings and keys", () => {
    const value = { "<key>": "a & b <c>" };
    const xml = dump(value);
    expect(parse(xml)).toEqual(value);
  });

  test("parse returns null for an empty document", () => {
    expect(parse("")).toBeNull();
  });

  test("parses a realistic GetDisplayNames-shaped response", () => {
    const xml =
      '<?xml version="1.0" ?><llsd><map>' +
      "<key>agents</key><array><map>" +
      "<key>id</key><uuid>550e8400-e29b-41d4-a716-446655440000</uuid>" +
      "<key>username</key><string>ruth.resident</string>" +
      "<key>display_name</key><string>Ruth Resident</string>" +
      "<key>legacy_first_name</key><string>Ruth</string>" +
      "<key>legacy_last_name</key><string>Resident</string>" +
      "</map></array>" +
      "</map></llsd>";
    const doc = parse(xml);
    expect(doc.agents).toHaveLength(1);
    expect(doc.agents[0]).toEqual({
      id: "550e8400-e29b-41d4-a716-446655440000",
      username: "ruth.resident",
      display_name: "Ruth Resident",
      legacy_first_name: "Ruth",
      legacy_last_name: "Resident",
    });
  });
});
