// Byte-level helpers for the LLUDP wire format (message ids, UUIDs, varints,
// zerocoding, little/big-endian ints) — TS port of the helpers at the top of
// backend/sl_circuit.py.

// TS 5.7+ made TypedArrays generic over their backing buffer (Uint8Array<ArrayBuffer>
// vs Uint8Array<ArrayBufferLike>, e.g. what .slice()/.subarray() on a socket-supplied
// buffer produce). We don't care which buffer backs a view here, so every function in
// this module is typed against the general form to avoid fighting that distinction.
export type Bytes = Uint8Array<ArrayBufferLike>;

export function concatBytes(...parts: Bytes[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function u8arr(...bytes: number[]): Bytes {
  return new Uint8Array(bytes);
}

// -- message-id prefixes (High / Medium / Low / Fixed) ----------------------
export function high(n: number): Bytes {
  return u8arr(n);
}
export function med(n: number): Bytes {
  return u8arr(0xff, n);
}
export function low(n: number): Bytes {
  return u8arr(0xff, 0xff, (n >> 8) & 0xff, n & 0xff);
}
export function fixed(n: number): Bytes {
  return u8arr(0xff, 0xff, 0xff, n);
}

export function bytesToHex(b: Bytes): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

// -- UUID <-> 16 raw bytes ----------------------------------------------------
export function uuidToBytes(u: string): Bytes {
  const hex = u.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
  return out;
}

export function bytesToUuid(b: Bytes, offset = 0): string {
  const hex = bytesToHex(b.slice(offset, offset + 16));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// -- utf-8, manual (no reliance on TextEncoder/TextDecoder being present) ---
export function utf8Encode(str: string): Bytes {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.codePointAt(i)!;
    if (code > 0xffff) i++; // consumed a surrogate pair
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

export function utf8Decode(bytes: Bytes): string {
  let out = "";
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0 && i + 1 < n) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0 && i + 2 < n) {
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else if ((b0 & 0xf8) === 0xf0 && i + 3 < n) {
      const cp =
        ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp);
      i += 4;
    } else {
      out += "�";
      i += 1;
    }
  }
  return out;
}

export function cstr(s: string): Bytes {
  return concatBytes(utf8Encode(s), u8arr(0));
}

export function var1(b: Bytes): Bytes {
  return concatBytes(u8arr(b.length & 0xff), b);
}

export function var2(b: Bytes): Bytes {
  const len = b.length;
  return concatBytes(u8arr(len & 0xff, (len >> 8) & 0xff), b);
}

/** Little-endian uint32. */
export function u32le(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

/** Big-endian uint32 (used for the 6-byte LLUDP packet header sequence number). */
export function u32be(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

/** Little-endian int32. */
export function i32le(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n | 0, true);
  return b;
}

/** Little-endian float32. */
export function f32le(n: number): Bytes {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n, true);
  return b;
}

export function f32le3(x: number, y: number, z: number): Bytes {
  return concatBytes(f32le(x), f32le(y), f32le(z));
}

export function floatsLE(...vals: number[]): Bytes {
  return concatBytes(...vals.map(f32le));
}

/** Mirrors Python's bytes.rstrip(b"\0") — strips every trailing NUL, not just one. */
export function rstripNulls(b: Bytes): Bytes {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return b.slice(0, end);
}

export function zeroDecode(b: Bytes): Bytes {
  const out: number[] = [];
  let i = 0;
  const n = b.length;
  while (i < n) {
    if (b[i] === 0 && i + 1 < n) {
      const count = b[i + 1];
      for (let k = 0; k < count; k++) out.push(0);
      i += 2;
    } else {
      out.push(b[i]);
      i += 1;
    }
  }
  return new Uint8Array(out);
}

export class Reader {
  i: number;
  constructor(public b: Bytes, i = 0) {
    this.i = i;
  }
  u8(): number {
    return this.b[this.i++];
  }
  u16(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getUint16(this.i, true);
    this.i += 2;
    return v;
  }
  u32(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getUint32(this.i, true);
    this.i += 4;
    return v;
  }
  s32(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getInt32(this.i, true);
    this.i += 4;
    return v;
  }
  f32(): number {
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getFloat32(this.i, true);
    this.i += 4;
    return v;
  }
  u64(): bigint {
    const v = new DataView(this.b.buffer, this.b.byteOffset, this.b.byteLength).getBigUint64(this.i, true);
    this.i += 8;
    return v;
  }
  uuid(): string {
    const v = bytesToUuid(this.b, this.i);
    this.i += 16;
    return v;
  }
  skip(n: number): void {
    this.i += n;
  }
  var1(): Bytes {
    const n = this.u8();
    const v = this.b.slice(this.i, this.i + n);
    this.i += n;
    return v;
  }
  var2(): Bytes {
    const n = this.u16();
    const v = this.b.slice(this.i, this.i + n);
    this.i += n;
    return v;
  }
  text1(): string {
    return utf8Decode(rstripNulls(this.var1()));
  }
  text2(): string {
    return utf8Decode(rstripNulls(this.var2()));
  }
}

/** Split a message body into (message-id bytes, remaining payload). */
export function splitMsgId(body: Bytes): [Bytes, Bytes] {
  if (body[0] !== 0xff) return [body.slice(0, 1), body.slice(1)];
  if (body[1] !== 0xff) return [body.slice(0, 2), body.slice(2)];
  return [body.slice(0, 4), body.slice(4)];
}
