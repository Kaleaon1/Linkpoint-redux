// Minimal non-validating XML parser used to decode LLSD+XML and XML-RPC
// responses from the SL grid. Good enough for the well-formed, attribute-light
// documents the grid sends (no external entities, no namespaces).

export type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
};

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const WS = /\s/;

export function parseXml(input: string): XmlNode | null {
  let i = 0;
  const n = input.length;

  function skipMisc(): void {
    for (;;) {
      while (i < n && WS.test(input[i])) i++;
      if (input.startsWith("<?", i)) {
        const end = input.indexOf("?>", i);
        i = end === -1 ? n : end + 2;
        continue;
      }
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (input.startsWith("<!", i) && !input.startsWith("<![CDATA[", i)) {
        const end = input.indexOf(">", i);
        i = end === -1 ? n : end + 1;
        continue;
      }
      break;
    }
  }

  function parseElement(): XmlNode | null {
    skipMisc();
    if (i >= n || input[i] !== "<") return null;
    i++; // consume '<'
    const nameMatch = /^[^\s/>]+/.exec(input.slice(i));
    if (!nameMatch) return null;
    const tag = nameMatch[0];
    i += tag.length;

    const attrs: Record<string, string> = {};
    for (;;) {
      while (i < n && WS.test(input[i])) i++;
      if (input.startsWith("/>", i)) {
        i += 2;
        return { tag, attrs, children: [], text: "" };
      }
      if (input[i] === ">") {
        i++;
        break;
      }
      const attrMatch = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(input.slice(i));
      if (!attrMatch) {
        // Malformed attribute area; bail out of the loop to avoid spinning.
        i++;
        continue;
      }
      attrs[attrMatch[1]] = decodeXmlEntities(attrMatch[3] !== undefined ? attrMatch[3] : attrMatch[4]);
      i += attrMatch[0].length;
    }

    const children: XmlNode[] = [];
    let text = "";
    for (;;) {
      if (i >= n) break;
      if (input.startsWith("</", i)) {
        const end = input.indexOf(">", i);
        i = end === -1 ? n : end + 1;
        break;
      }
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (input.startsWith("<![CDATA[", i)) {
        const end = input.indexOf("]]>", i);
        text += end === -1 ? input.slice(i + 9) : input.slice(i + 9, end);
        i = end === -1 ? n : end + 3;
        continue;
      }
      if (input[i] === "<") {
        const child = parseElement();
        if (child) children.push(child);
        continue;
      }
      const next = input.indexOf("<", i);
      const raw = next === -1 ? input.slice(i) : input.slice(i, next);
      text += decodeXmlEntities(raw);
      i = next === -1 ? n : next;
    }
    return { tag, attrs, children, text };
  }

  return parseElement();
}

export function findChild(el: XmlNode, tag: string): XmlNode | undefined {
  return el.children.find((c) => c.tag === tag);
}
