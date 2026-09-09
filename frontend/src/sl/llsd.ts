// Minimal LLSD+XML encode/decode (the wire format used by Second Life
// capabilities such as the seed cap, GetDisplayNames, AvatarPickerSearch and
// EventQueueGet). Faithful port of backend/llsd.py.
import { Buffer } from "buffer";

import { escapeXml, parseXml, type XmlNode } from "./xml-lite";

export const NULL_UUID = "00000000-0000-0000-0000-000000000000";

/** Marker so dump() emits <uuid> instead of <string>. */
export class LLSDUUID {
  constructor(public value: string) {}
}

/** Marker so dump() emits <real> for a value that must stay a float (e.g. "1.0" not "1"). */
export class LLSDReal {
  constructor(public value: number) {}
}

export function parse(text: string): any {
  const root = parseXml(text);
  if (!root) return null;
  const first = root.children[0];
  return first ? node(first) : null;
}

function node(el: XmlNode): any {
  switch (el.tag) {
    case "map": {
      const out: Record<string, any> = {};
      const kids = el.children;
      for (let i = 0; i + 1 < kids.length; i += 2) {
        if (kids[i].tag === "key") out[kids[i].text ?? ""] = node(kids[i + 1]);
      }
      return out;
    }
    case "array":
      return el.children.map(node);
    case "string":
      return el.text ?? "";
    case "integer":
      return parseInt(el.text || "0", 10);
    case "real":
      return parseFloat(el.text || "0");
    case "boolean":
      return (el.text || "").trim().toLowerCase() === "true" || (el.text || "").trim() === "1";
    case "uuid":
      return el.text || NULL_UUID;
    case "binary":
      return Buffer.from(el.text || "", "base64");
    case "undef":
      return null;
    default:
      return el.text;
  }
}

export function dump(value: any): string {
  return '<?xml version="1.0" ?><llsd>' + enc(value) + "</llsd>";
}

function enc(v: any): string {
  if (v === null || v === undefined) return "<undef/>";
  if (v instanceof LLSDUUID) return `<uuid>${v.value}</uuid>`;
  if (v instanceof LLSDReal) return `<real>${v.value}</real>`;
  if (typeof v === "boolean") return `<boolean>${v ? "true" : "false"}</boolean>`;
  if (typeof v === "number") return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`;
  if (typeof v === "string") return `<string>${escapeXml(v)}</string>`;
  if (v instanceof Uint8Array) return `<binary>${Buffer.from(v).toString("base64")}</binary>`;
  if (Array.isArray(v)) return "<array>" + v.map(enc).join("") + "</array>";
  if (typeof v === "object") {
    return (
      "<map>" +
      Object.entries(v)
        .map(([k, x]) => `<key>${escapeXml(String(k))}</key>${enc(x)}`)
        .join("") +
      "</map>"
    );
  }
  return `<string>${escapeXml(String(v))}</string>`;
}
