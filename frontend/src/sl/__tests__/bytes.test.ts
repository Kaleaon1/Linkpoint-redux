import {
  Reader,
  bytesToHex,
  bytesToUuid,
  concatBytes,
  cstr,
  f32le,
  fixed,
  floatsLE,
  high,
  i32le,
  low,
  med,
  rstripNulls,
  splitMsgId,
  u32be,
  u32le,
  u8arr,
  utf8Decode,
  utf8Encode,
  uuidToBytes,
  var1,
  var2,
  zeroDecode,
} from "../bytes";

describe("message-id prefixes", () => {
  test("high/med/low/fixed byte shapes", () => {
    expect(Array.from(high(4))).toEqual([4]);
    expect(Array.from(med(6))).toEqual([0xff, 6]);
    expect(Array.from(low(139))).toEqual([0xff, 0xff, 0x00, 0x8b]);
    expect(Array.from(fixed(0xfb))).toEqual([0xff, 0xff, 0xff, 0xfb]);
  });

  test("splitMsgId recognizes all four encodings", () => {
    const [hId, hRest] = splitMsgId(concatBytes(high(4), u8arr(9, 9)));
    expect(bytesToHex(hId)).toBe("04");
    expect(Array.from(hRest)).toEqual([9, 9]);

    const [mId, mRest] = splitMsgId(concatBytes(med(6), u8arr(9)));
    expect(bytesToHex(mId)).toBe("ff06");
    expect(Array.from(mRest)).toEqual([9]);

    const [lId, lRest] = splitMsgId(concatBytes(low(139), u8arr(9)));
    expect(bytesToHex(lId)).toBe("ffff008b");
    expect(Array.from(lRest)).toEqual([9]);

    const [fId, fRest] = splitMsgId(concatBytes(fixed(0xfb), u8arr(9)));
    expect(bytesToHex(fId)).toBe("fffffffb");
    expect(Array.from(fRest)).toEqual([9]);
  });
});

describe("UUID <-> bytes round-trip", () => {
  test("round-trips a UUID string through bytes", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const bytes = uuidToBytes(id);
    expect(bytes.length).toBe(16);
    expect(bytesToUuid(bytes)).toBe(id);
  });

  test("reads a UUID at an offset inside a larger buffer", () => {
    const id = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const buf = concatBytes(u8arr(1, 2, 3), uuidToBytes(id), u8arr(9));
    expect(bytesToUuid(buf, 3)).toBe(id);
  });

  test("all-zero UUID", () => {
    const zero = "00000000-0000-0000-0000-000000000000";
    expect(bytesToUuid(uuidToBytes(zero))).toBe(zero);
  });
});

describe("utf8 encode/decode round-trip", () => {
  test.each([
    ["ascii", "hello world"],
    ["two-byte", "café"],
    ["three-byte", "日本語"],
    ["four-byte / surrogate pair", "😀🚀"],
    ["mixed", "GridLink 🌐 café 日本語"],
    ["empty", ""],
  ])("%s: %s", (_label, s) => {
    expect(utf8Decode(utf8Encode(s))).toBe(s);
  });
});

describe("cstr / var1 / var2 framing", () => {
  test("cstr appends a single trailing NUL", () => {
    const b = cstr("hi");
    expect(Array.from(b)).toEqual([0x68, 0x69, 0x00]);
  });

  test("var1 prefixes a 1-byte length", () => {
    const b = var1(u8arr(1, 2, 3));
    expect(Array.from(b)).toEqual([3, 1, 2, 3]);
  });

  test("var2 prefixes a 2-byte little-endian length", () => {
    const payload = new Uint8Array(300).fill(7);
    const b = var2(payload);
    expect(b[0]).toBe(300 & 0xff);
    expect(b[1]).toBe((300 >> 8) & 0xff);
    expect(b.length).toBe(302);
  });
});

describe("rstripNulls", () => {
  test("strips every trailing NUL, not just one", () => {
    expect(Array.from(rstripNulls(u8arr(1, 2, 0, 0, 0)))).toEqual([1, 2]);
  });
  test("no-op when there's no trailing NUL", () => {
    expect(Array.from(rstripNulls(u8arr(1, 2, 3)))).toEqual([1, 2, 3]);
  });
  test("all-NUL input strips to empty", () => {
    expect(Array.from(rstripNulls(u8arr(0, 0)))).toEqual([]);
  });
});

describe("zeroDecode", () => {
  test("expands a zero-run marker", () => {
    // 0x00 0x03 means "three zero bytes" in LLUDP zerocoding.
    expect(Array.from(zeroDecode(u8arr(1, 0, 3, 2)))).toEqual([1, 0, 0, 0, 2]);
  });
  test("passes non-zero bytes through unchanged", () => {
    expect(Array.from(zeroDecode(u8arr(5, 6, 7)))).toEqual([5, 6, 7]);
  });
  test("a trailing lone zero byte (no count byte) is kept as-is", () => {
    expect(Array.from(zeroDecode(u8arr(1, 0)))).toEqual([1, 0]);
  });
});

describe("little/big-endian numeric helpers via Reader", () => {
  test("u32le round-trip", () => {
    const r = new Reader(u32le(305419896));
    expect(r.u32()).toBe(305419896);
  });
  test("u32be matches DataView big-endian encoding", () => {
    const b = u32be(1);
    expect(Array.from(b)).toEqual([0, 0, 0, 1]);
  });
  test("i32le round-trip with a negative number", () => {
    const r = new Reader(i32le(-42));
    expect(r.s32()).toBe(-42);
  });
  test("f32le round-trip", () => {
    const r = new Reader(f32le(64.0));
    expect(r.f32()).toBeCloseTo(64.0, 5);
  });
  test("floatsLE concatenates multiple f32le values", () => {
    const r = new Reader(floatsLE(1, 2, 3));
    expect(r.f32()).toBeCloseTo(1);
    expect(r.f32()).toBeCloseTo(2);
    expect(r.f32()).toBeCloseTo(3);
  });
});

describe("Reader", () => {
  test("reads a full mixed-field packet body in order", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const body = concatBytes(
      u8arr(7), // u8
      u32le(42), // u32
      uuidToBytes(id), // uuid
      var1(cstr("Ruth")), // text1
      var2(cstr("hello there")), // text2
    );
    const r = new Reader(body);
    expect(r.u8()).toBe(7);
    expect(r.u32()).toBe(42);
    expect(r.uuid()).toBe(id);
    expect(r.text1()).toBe("Ruth");
    expect(r.text2()).toBe("hello there");
  });

  test("u64 reads a big-endian-free 64-bit value as bigint", () => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, 123456789012345n, true);
    const r = new Reader(b);
    expect(r.u64()).toBe(123456789012345n);
  });

  test("skip advances the cursor without reading", () => {
    const r = new Reader(u8arr(1, 2, 3, 4));
    r.skip(2);
    expect(r.u8()).toBe(3);
  });
});
