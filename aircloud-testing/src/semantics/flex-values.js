// @aircloudhq/testing — Air-Flex value semantics: the I4 type representations, their validation,
// canonical form, native ordering and equality.
//
// SOURCE OF TRUTH: contracts/flex/v1/types.json (representations, op×type and fn×type matrices)
// and responses.json (ordering + equality fixtures), as implemented by flex/src/types.rs and
// flex/src/ast.rs. Error MESSAGES are the flex-jit's own strings, so a Builder's assertion on a
// message holds against the chokepoint too. The package's tests run the contract's own fixtures
// through these functions (test/flex-contract.test.mjs), so the mirror is checked, not trusted.
import { CapabilityFailure } from "../errors.js";

export const FIELD_TYPES = ["text", "integer", "decimal", "boolean", "datetime", "date", "json", "relation", "file", "vector"];
export const SLUG_RE = /^[a-z][a-z0-9_]{0,62}$/;
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DECIMAL_RE = /^-?[0-9]+(\.[0-9]+)?$/;
const DECIMAL_MAX_DIGITS = 60;
const TEXT_MAX_UTF8_BYTES = 65536;
const INTEGER_MAX_ABS = 9007199254740991;
const VECTOR_DIMS_MIN = 1;
const VECTOR_DIMS_MAX = 2000;
const MASKING_STRATEGIES = ["null", "redact", "hash", "fake_by_type"];

/** A flex.validation refusal; `field` makes it field-scoped (details.fields.<field>). */
export function validation(message, field) {
  return new CapabilityFailure("flex.validation", message, field ? { fields: { [field]: message } } : {});
}

export function jsonKind(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  return "object";
}

// ── config ─────────────────────────────────────────────────────────────────────────────
export function parseConfig(type, config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw validation("config must be a JSON object");
  if ("masking" in config) validateMasking(config.masking);
  const keys = Object.keys(config).filter((k) => k !== "masking");
  if (type === "relation") {
    for (const k of keys) if (k !== "target_entity_id") throw validation(`unknown relation config key '${k}'`);
    if (!("target_entity_id" in config)) throw validation("relation config requires 'target_entity_id'");
    const s = config.target_entity_id;
    if (typeof s !== "string") throw validation("target_entity_id must be a UUID string");
    if (!ID_RE.test(s)) throw validation(`target_entity_id '${s}' is not a UUIDv7`);
    return { targetEntityId: s };
  }
  if (type === "vector") {
    for (const k of keys) if (k !== "dims") throw validation(`unknown vector config key '${k}'`);
    if (!("dims" in config)) throw validation("vector config requires 'dims'");
    const d = config.dims;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0) throw validation("dims must be a positive integer");
    if (d < VECTOR_DIMS_MIN || d > VECTOR_DIMS_MAX) throw validation(`dims ${d} out of range ${VECTOR_DIMS_MIN}..=${VECTOR_DIMS_MAX}`);
    return { dims: d };
  }
  if (keys.length > 0) throw validation(`${type} takes no config keys`);
  return {};
}

function validateMasking(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) throw validation("field config 'masking' must be a JSON object");
  for (const k of Object.keys(m)) if (k !== "sensitive" && k !== "strategy") throw validation(`unknown masking config key '${k}'`);
  if (typeof m.sensitive !== "boolean") throw validation("masking.sensitive must be a boolean");
  if ("strategy" in m) {
    if (typeof m.strategy !== "string") throw validation("masking.strategy must be a string");
    if (!MASKING_STRATEGIES.includes(m.strategy)) throw validation(`unknown masking strategy '${m.strategy}'`);
  } else if (m.sensitive) {
    throw validation("masking.strategy is required when masking.sensitive is true");
  }
}

// ── values ─────────────────────────────────────────────────────────────────────────────
function typeError(typeName, v) {
  return validation(`expected ${typeName}, got ${jsonKind(v)}`);
}

export function validateValue(field, v) {
  switch (field.type) {
    case "text":
      if (typeof v !== "string") throw typeError("text", v);
      if (Buffer.byteLength(v, "utf8") > TEXT_MAX_UTF8_BYTES) throw validation(`text exceeds ${TEXT_MAX_UTF8_BYTES} UTF-8 bytes`);
      return;
    case "integer":
      if (typeof v !== "number") throw typeError("integer", v);
      if (!Number.isInteger(v)) throw validation("integer must be an integral JSON number");
      if (Math.abs(v) > INTEGER_MAX_ABS) {
        throw validation(`integer out of JS-safe range ±${INTEGER_MAX_ABS} (use decimal for larger magnitudes)`);
      }
      return;
    case "decimal": {
      if (typeof v !== "string") throw validation(`decimal must be a JSON string, got ${jsonKind(v)}`);
      if (!DECIMAL_RE.test(v)) throw validation(`decimal '${v}' is malformed (grammar ^-?[0-9]+(\\.[0-9]+)?$, no exponent)`);
      const digits = (v.match(/[0-9]/g) || []).length;
      if (digits > DECIMAL_MAX_DIGITS) throw validation(`decimal has ${digits} digits, exceeds max ${DECIMAL_MAX_DIGITS}`);
      return;
    }
    case "boolean":
      if (typeof v !== "boolean") throw typeError("boolean", v);
      return;
    case "datetime":
      if (typeof v !== "string") throw typeError("datetime", v);
      if (parseDatetime(v) === null) throw validation(`'${v}' is not an RFC 3339 datetime`);
      return;
    case "date":
      if (typeof v !== "string") throw typeError("date", v);
      if (!isCalendarDate(v)) throw validation(`'${v}' is not a YYYY-MM-DD calendar date`);
      return;
    case "json":
      return;
    case "relation":
      if (typeof v !== "string") throw typeError("relation", v);
      if (!ID_RE.test(v)) throw validation(`relation '${v}' is not a UUIDv7 target record id`);
      return;
    case "file":
      validateFile(v);
      return;
    case "vector": {
      if (!Array.isArray(v)) throw typeError("vector (array of numbers)", v);
      if (v.length !== field.parsed.dims) throw validation(`vector length ${v.length} != declared dims ${field.parsed.dims}`);
      v.forEach((el, i) => {
        if (typeof el !== "number" || !Number.isFinite(el)) throw validation(`vector element ${i} is ${jsonKind(el)}, not a number`);
      });
      return;
    }
    default:
      throw new Error(`@aircloudhq/testing: unknown flex type '${field.type}'`);
  }
}

function validateFile(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw typeError("file object", v);
  for (const k of Object.keys(v)) if (!["key", "content_type", "size_bytes"].includes(k)) throw validation(`unknown file key '${k}'`);
  if (!("key" in v)) throw validation("file requires a string 'key'");
  if (typeof v.key !== "string") throw validation("file 'key' must be a string");
  if ("content_type" in v && !(typeof v.content_type === "string" || v.content_type === null)) {
    throw validation("file 'content_type' must be a string or null");
  }
  if ("size_bytes" in v && !(typeof v.size_bytes === "number" || v.size_bytes === null)) {
    throw validation("file 'size_bytes' must be a number or null");
  }
}

/** Canonical output form (I4): only datetime transforms, to YYYY-MM-DDTHH:MM:SS.ssssssZ. */
export function canonicalize(field, v) {
  if (field.type !== "datetime") return v;
  const p = parseDatetime(v);
  return formatDatetimeMicros(p);
}

// RFC 3339: date-time with a mandatory offset (Z or ±HH:MM), optional fraction (any length —
// truncated to microseconds, the chokepoint's storage precision).
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** → epoch MICROseconds as a BigInt, or null when not RFC 3339. */
export function parseDatetime(s) {
  const m = RFC3339_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, se, frac, off] = m;
  if (!isCalendarDate(`${y}-${mo}-${d}`)) return null;
  if (+h > 23 || +mi > 59 || +se > 60) return null;
  let offMin = 0;
  if (off !== "Z" && off !== "z") {
    const sign = off[0] === "-" ? -1 : 1;
    const oh = +off.slice(1, 3);
    const om = +off.slice(4, 6);
    if (oh > 23 || om > 59) return null;
    offMin = sign * (oh * 60 + om);
  }
  const baseMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, Math.min(+se, 59)) - offMin * 60000;
  const micros = frac ? BigInt((frac.slice(1) + "000000").slice(0, 6)) : 0n;
  return BigInt(baseMs) * 1000n + micros + (+se === 60 ? 1000000n : 0n);
}

export function formatDatetimeMicros(us) {
  const ms = Number(us / 1000n);
  const micro = ((us % 1000000n) + 1000000n) % 1000000n;
  const d = new Date(Math.floor(ms / 1000) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(Number(micro), 6)}Z`;
}

export function isCalendarDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[mo - 1];
}

// ── exact decimal arithmetic (numeric) ─────────────────────────────────────────────────
/** "−12.340" → { n: -12340n, scale: 3 } (the stored literal's own scale is kept). */
export function parseDecimal(s) {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [i, f = ""] = body.split(".");
  const n = BigInt(i + f);
  return { n: neg ? -n : n, scale: f.length };
}

function rescale(a, scale) {
  return a.n * 10n ** BigInt(scale - a.scale);
}

export function compareDecimal(a, b) {
  const scale = Math.max(a.scale, b.scale);
  const x = rescale(a, scale);
  const y = rescale(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Postgres numeric text: no leading zeros, the value's display scale, '-0' → '0'. */
export function formatDecimal({ n, scale }) {
  const neg = n < 0n;
  let digits = (neg ? -n : n).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  const out = scale > 0 ? `${int}.${frac}` : int;
  return neg && n !== 0n ? `-${out}` : out;
}

export function sumDecimals(values) {
  const scale = values.reduce((s, v) => Math.max(s, v.scale), 0);
  return { n: values.reduce((acc, v) => acc + rescale(v, scale), 0n), scale };
}

/** avg rounded half-even to exactly 6 fractional digits (flex exec.rs round_half_even_6). */
export function avgDecimals(values) {
  const total = sumDecimals(values);
  const count = BigInt(values.length);
  // value × 10^6 as an exact rational: total.n × 10^6 / (10^scale × count)
  const num = total.n * 1000000n;
  const den = 10n ** BigInt(total.scale) * count;
  const neg = num < 0n;
  const a = neg ? -num : num;
  let q = a / den;
  const r = a % den;
  if (r * 2n > den || (r * 2n === den && q % 2n === 1n)) q += 1n;
  return formatDecimal({ n: neg ? -q : q, scale: 6 });
}

// ── jsonb storage form ───────────────────────────────────────────────────────────────
/**
 * Postgres jsonb stores object keys shorter-first, then bytewise — the order a record's `data`
 * (and any nested json value) comes back in. Applied on write, so every read returns it.
 */
export function jsonbForm(v) {
  if (Array.isArray(v)) return v.map(jsonbForm);
  if (v === null || typeof v !== "object") return v;
  const keys = Object.keys(v).sort((a, b) => {
    const la = Buffer.byteLength(a);
    const lb = Buffer.byteLength(b);
    return la - lb || Buffer.compare(Buffer.from(a), Buffer.from(b));
  });
  return Object.fromEntries(keys.map((k) => [k, jsonbForm(v[k])]));
}

// ── native order + equality ────────────────────────────────────────────────────────────
function utf8Compare(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Native comparison of two NON-null values of one field type (the ::numeric/::timestamptz/::date casts). */
export function compareNative(type, a, b) {
  switch (type) {
    case "integer":
      return a < b ? -1 : a > b ? 1 : 0;
    case "decimal":
      return compareDecimal(parseDecimal(String(a)), parseDecimal(String(b)));
    case "datetime": {
      const x = parseDatetime(a);
      const y = parseDatetime(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case "date":
      return a < b ? -1 : a > b ? 1 : 0;
    case "boolean":
      return a === b ? 0 : a ? 1 : -1;
    default:
      return utf8Compare(String(a), String(b));
  }
}
