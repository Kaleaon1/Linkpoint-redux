// Minimal XML-RPC client for the SL grid login handshake
// (POST to https://login.<grid>.lindenlab.com/cgi-bin/login.cgi,
// method "login_to_simulator"). Only the value types the login call
// actually uses are covered: string, int, boolean, double, array, struct.
import { escapeXml, findChild, parseXml, type XmlNode } from "./xml-lite";

export type XmlRpcValue = null | boolean | number | string | XmlRpcValue[] | { [k: string]: XmlRpcValue };

export class XmlRpcFault extends Error {
  constructor(public faultCode: number, public faultString: string) {
    super(faultString);
    this.name = "XmlRpcFault";
  }
}

function encodeValue(v: XmlRpcValue): string {
  if (v === null || v === undefined) return "<value><nil/></value>";
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") {
    return Number.isInteger(v) ? `<value><int>${v}</int></value>` : `<value><double>${v}</double></value>`;
  }
  if (typeof v === "string") return `<value><string>${escapeXml(v)}</string></value>`;
  if (Array.isArray(v)) return `<value><array><data>${v.map(encodeValue).join("")}</data></array></value>`;
  if (typeof v === "object") {
    const members = Object.entries(v)
      .map(([k, val]) => `<member><name>${escapeXml(k)}</name>${encodeValue(val)}</member>`)
      .join("");
    return `<value><struct>${members}</struct></value>`;
  }
  return `<value><string>${escapeXml(String(v))}</string></value>`;
}

export function buildRequest(methodName: string, params: XmlRpcValue[]): string {
  const paramsXml = params.map((p) => `<param>${encodeValue(p)}</param>`).join("");
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(methodName)}</methodName><params>${paramsXml}</params></methodCall>`;
}

function decodeValue(valueEl: XmlNode): XmlRpcValue {
  const typed = valueEl.children[0];
  if (!typed) return valueEl.text ?? "";
  switch (typed.tag) {
    case "string":
      return typed.text ?? "";
    case "int":
    case "i4":
    case "i8":
      return parseInt(typed.text || "0", 10);
    case "double":
      return parseFloat(typed.text || "0");
    case "boolean":
      return (typed.text || "").trim() === "1";
    case "nil":
      return null;
    case "array": {
      const dataEl = findChild(typed, "data");
      const items = dataEl ? dataEl.children.filter((c) => c.tag === "value") : [];
      return items.map(decodeValue);
    }
    case "struct": {
      const out: Record<string, XmlRpcValue> = {};
      for (const member of typed.children) {
        if (member.tag !== "member") continue;
        const nameEl = findChild(member, "name");
        const valEl = findChild(member, "value");
        if (nameEl && valEl) out[nameEl.text ?? ""] = decodeValue(valEl);
      }
      return out;
    }
    default:
      return typed.text ?? "";
  }
}

/** POST an XML-RPC request and return the decoded result struct, throwing XmlRpcFault on <fault>. */
export async function call(uri: string, methodName: string, params: XmlRpcValue[], timeoutMs = 20000): Promise<XmlRpcValue> {
  const body = buildRequest(methodName, params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text: string;
  try {
    const r = await fetch(uri, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body,
      signal: controller.signal,
    });
    text = await r.text();
  } finally {
    clearTimeout(timer);
  }
  const root = parseXml(text);
  if (!root) throw new Error("empty XML-RPC response");
  const faultEl = findChild(root, "fault");
  if (faultEl) {
    const valueEl = findChild(faultEl, "value");
    const structVal = (valueEl ? decodeValue(valueEl) : {}) as Record<string, XmlRpcValue>;
    throw new XmlRpcFault(Number(structVal.faultCode ?? -1), String(structVal.faultString ?? "unknown fault"));
  }
  const paramsEl = findChild(root, "params");
  const paramEl = paramsEl?.children.find((c) => c.tag === "param");
  const valueEl = paramEl && findChild(paramEl, "value");
  return valueEl ? decodeValue(valueEl) : null;
}
