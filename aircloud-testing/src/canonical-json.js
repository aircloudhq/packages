// @aircloudhq/testing — canonical JSON and the composite request encoding (ADR-302 decision 8; design
// 2026-11-05-platform-effect-idempotency D15, section 2.2): the JS twin of control-plane/internal/durability
// (canonjson.go, composite.go) and crates/durability (canonjson.rs, composite.rs), held to
// contracts/durability/v1/request-digest-vectors.json (test/canonical-json.test.mjs).
//
// A document is I-JSON BY CONTRACT: a duplicate object key, a U+0000 or an unpaired surrogate in a string, a number
// whose literal and canonical form denote different decimal values (2^53 + 1, 0.30000000000000001, a non-finite
// value), nesting past MAX_JSON_DEPTH and any syntax error are refused (an IJsonError carrying the reason), so the
// double answers the production executor's *.validation. Inside that domain the canonical form (RFC 8785: keys sorted
// by UTF-16 code units, no whitespace, minimal escapes, ES6 Number::toString numbers) is lossless. The parser is
// in-house: JSON.parse keeps the last of two duplicate keys and never shows a number's literal.
import { createHash } from "node:crypto";

/** A document's nesting bound (arrays and objects), the Go and Rust bound. */
export const MAX_JSON_DEPTH = 128;

/** A refused document: `reason` is syntax | duplicate_key | nul | lone_surrogate | number | depth. */
export class IJsonError extends Error {
  constructor(reason, offset) {
    super(`the document is not I-JSON (${reason} at ${offset})`);
    this.name = "IJsonError";
    this.reason = reason;
    this.offset = offset;
  }
}

/** A JSON number literal's decimal value: sign, significant digits, exponent e with value = 0.<digits> × 10^e. */
function decimalOf(lit) {
  let neg = false;
  if (lit.startsWith("-")) {
    neg = true;
    lit = lit.slice(1);
  }
  let exp = 0;
  const e = lit.search(/[eE]/);
  if (e >= 0) {
    exp = Number.parseInt(lit.slice(e + 1), 10);
    lit = lit.slice(0, e);
  }
  const [intPart, frac = ""] = lit.split(".");
  const d = intPart + frac;
  exp += intPart.length;
  let s = d.replace(/^0+/, "");
  exp -= d.length - s.length;
  s = s.replace(/0+$/, "");
  if (s === "") return "0";
  return `${neg ? "-" : ""}0.${s}e${exp}`;
}

/** ECMAScript's Number::toString of a finite double — what RFC 8785 lays every number out as; -0 is "0". */
export function es6Number(f) {
  return String(f);
}

function canonicalString(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

// UTF-16 code-unit order: JS strings ARE UTF-16, and `<` compares code units.
const byUnits = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

// A request body's bytes decode strictly: a byte sequence that is not UTF-8 is refused, never replaced by U+FFFD
// (which would give two different documents one digest), and a leading BOM is kept, so it is refused as the Go and
// Rust parsers refuse it.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Parse `doc` — text, or the document's bytes (a Uint8Array / Buffer: a raw request body) — as I-JSON and return
 * its RFC 8785 canonical form (throws IJsonError; bytes that are not UTF-8 are a syntax refusal).
 */
export function canonicalJSON(doc) {
  let text = doc;
  if (typeof doc !== "string") {
    try {
      text = utf8.decode(doc);
    } catch {
      throw new IJsonError("syntax", 0);
    }
  }
  let i = 0;
  const fail = (reason, at = i) => new IJsonError(reason, at);
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const hex4 = () => {
    const h = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) throw fail("syntax");
    i += 4;
    return Number.parseInt(h, 16);
  };
  const str = () => {
    i++; // "
    let b = "";
    for (;;) {
      if (i >= text.length) throw fail("syntax");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return b;
      }
      if (c < 0x20) throw fail("syntax");
      if (c >= 0xd800 && c <= 0xdbff) {
        const lo = text.charCodeAt(i + 1);
        if (!(lo >= 0xdc00 && lo <= 0xdfff)) throw fail("lone_surrogate");
        b += text.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) throw fail("lone_surrogate");
      if (c !== 0x5c) {
        b += text[i++];
        continue;
      }
      const at = i;
      i++;
      const e = text[i++];
      const short = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (e in short) {
        b += short[e];
        continue;
      }
      if (e !== "u") throw fail("syntax", at);
      const r = hex4();
      if (r === 0) throw fail("nul", at);
      if (r >= 0xdc00 && r <= 0xdfff) throw fail("lone_surrogate", at);
      if (r >= 0xd800 && r <= 0xdbff) {
        if (text.slice(i, i + 2) !== "\\u") throw fail("lone_surrogate", at);
        i += 2;
        const lo = hex4();
        if (lo < 0xdc00 || lo > 0xdfff) throw fail("lone_surrogate", at);
        b += String.fromCharCode(r, lo);
        continue;
      }
      b += String.fromCharCode(r);
    }
  };
  const num = () => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (!m) throw fail("syntax");
    const start = i;
    const lit = m[0];
    i += lit.length;
    const f = Number(lit);
    if (!Number.isFinite(f)) throw fail("number", start);
    const c = es6Number(f);
    if (decimalOf(c) !== decimalOf(lit)) throw fail("number", start);
    return c;
  };
  const value = (depth) => {
    if (i >= text.length) throw fail("syntax");
    const c = text[i];
    if (c === "{" || c === "[") {
      if (depth + 1 > MAX_JSON_DEPTH) throw fail("depth");
      i++;
      ws();
      const close = c === "{" ? "}" : "]";
      if (text[i] === close) {
        i++;
        return c + close;
      }
      const items = [];
      const seen = new Set();
      for (;;) {
        ws();
        if (c === "{") {
          if (text[i] !== '"') throw fail("syntax");
          const at = i;
          const k = str();
          if (seen.has(k)) throw fail("duplicate_key", at);
          seen.add(k);
          ws();
          if (text[i] !== ":") throw fail("syntax");
          i++;
          ws();
          items.push([k, value(depth + 1)]);
        } else {
          items.push(value(depth + 1));
        }
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== close) throw fail("syntax");
        i++;
        break;
      }
      if (c === "[") return `[${items.join(",")}]`;
      items.sort(byUnits);
      return `{${items.map(([k, v]) => `${canonicalString(k)}:${v}`).join(",")}}`;
    }
    if (c === '"') return canonicalString(str());
    for (const w of ["true", "false", "null"]) {
      if (text.startsWith(w, i)) {
        i += w.length;
        return w;
      }
    }
    if (c === "-" || (c >= "0" && c <= "9")) return num();
    throw fail("syntax");
  };
  ws();
  const out = value(0);
  ws();
  if (i !== text.length) throw fail("syntax");
  return out;
}

/** The canonical form of a value the double already holds (a document it built), under the same rules. */
export function canonicalizeValue(v, depth = 0) {
  if (v === null || v === true || v === false) return String(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new IJsonError("number", 0);
    return es6Number(v);
  }
  if (typeof v === "string") return canonicalJSON(JSON.stringify(v));
  if (depth + 1 > MAX_JSON_DEPTH) throw new IJsonError("depth", 0);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalizeValue(x, depth + 1)).join(",")}]`;
  if (typeof v === "object") {
    const items = Object.keys(v).map((k) => [k, v[k]]);
    for (const [k] of items) canonicalJSON(JSON.stringify(k));
    items.sort(byUnits);
    return `{${items.map(([k, x]) => `${canonicalString(k)}:${canonicalizeValue(x, depth + 1)}`).join(",")}}`;
  }
  throw new IJsonError("syntax", 0);
}

function uvarint(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n === 0) {
      out.push(b);
      return Buffer.from(out);
    }
    out.push(b | 0x80);
  }
}

/** The composite request encoding: each field uvarint(len) ‖ bytes; an absent optional 0, a present one 1 then it. */
export class Composite {
  constructor() {
    this.parts = [];
  }
  bytes(b) {
    const buf = Buffer.from(b);
    this.parts.push(uvarint(buf.length), buf);
    return this;
  }
  str(s) {
    return this.bytes(Buffer.from(s, "utf8"));
  }
  opt(s) {
    if (s === undefined || s === null) this.parts.push(Buffer.from([0]));
    else {
      this.parts.push(Buffer.from([1]));
      this.str(s);
    }
    return this;
  }
  encoding() {
    return Buffer.concat(this.parts);
  }
  sum() {
    return createHash("sha256").update(this.encoding()).digest();
  }
}
