"""Minimal LLSD+XML encode/decode (the wire format used by Second Life
capabilities such as the seed cap, GetDisplayNames, AvatarPickerSearch and
EventQueueGet)."""
import base64
import xml.etree.ElementTree as ET
from typing import Any
from xml.sax.saxutils import escape

NULL_UUID = "00000000-0000-0000-0000-000000000000"


class UUIDStr(str):
    """Marker so dump() emits <uuid> instead of <string>."""


def parse(text: str) -> Any:
    root = ET.fromstring(text)
    kids = list(root)
    return _node(kids[0]) if kids else None


def _node(el: ET.Element) -> Any:
    t = el.tag
    if t == "map":
        out = {}
        kids = list(el)
        for i in range(0, len(kids) - 1, 2):
            if kids[i].tag == "key":
                out[kids[i].text or ""] = _node(kids[i + 1])
        return out
    if t == "array":
        return [_node(k) for k in el]
    if t == "string":
        return el.text or ""
    if t == "integer":
        return int(el.text or 0)
    if t == "real":
        return float(el.text or 0)
    if t == "boolean":
        return (el.text or "").strip().lower() in ("true", "1")
    if t == "uuid":
        return el.text or NULL_UUID
    if t == "binary":
        return base64.b64decode(el.text or "")
    if t == "undef":
        return None
    return el.text


def dump(value: Any) -> str:
    return '<?xml version="1.0" ?><llsd>' + _enc(value) + "</llsd>"


def _enc(v: Any) -> str:
    if v is None:
        return "<undef/>"
    if isinstance(v, UUIDStr):
        return f"<uuid>{v}</uuid>"
    if isinstance(v, bool):
        return f"<boolean>{'true' if v else 'false'}</boolean>"
    if isinstance(v, int):
        return f"<integer>{v}</integer>"
    if isinstance(v, float):
        return f"<real>{v}</real>"
    if isinstance(v, str):
        return f"<string>{escape(v)}</string>"
    if isinstance(v, bytes):
        return f"<binary>{base64.b64encode(v).decode()}</binary>"
    if isinstance(v, dict):
        return "<map>" + "".join(f"<key>{escape(str(k))}</key>{_enc(x)}" for k, x in v.items()) + "</map>"
    if isinstance(v, (list, tuple)):
        return "<array>" + "".join(_enc(x) for x in v) + "</array>"
    return f"<string>{escape(str(v))}</string>"
