// @aircloudhq/testing — the platform's derived id (ADR-302 decision 8): a UUID version 5 (RFC 9562 § 5.5) over a
// declared namespace and the key's canonical bytes. It is the JS twin of control-plane/internal/durability IDv5 and
// crates/durability idv5; contracts/durability/v1/idv5-vectors.json holds all three to the same vectors
// (test/idv5.test.mjs), and the namespaces are the generated src/namespaces_gen.js.
import { createHash } from "node:crypto";

const HEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A UUID string → its 16 bytes. */
export function uuidBytes(id) {
  if (typeof id !== "string" || !HEX_UUID.test(id)) throw new TypeError(`not a UUID: ${id}`);
  return Buffer.from(id.replace(/-/g, ""), "hex");
}

function format(b) {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** IDv5(namespace, key): SHA-1 over the namespace's 16 bytes then the key's bytes, laid out as version 5. */
export function idv5(namespace, key) {
  const sum = createHash("sha1").update(uuidBytes(namespace)).update(Buffer.from(key)).digest();
  const b = Buffer.from(sum.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  return format(b);
}

/** NUL-joined UTF-8 segments behind a UUID's 16 bytes — the encoding of every tenant-scoped key. */
export function scopedKey(id, ...segments) {
  const parts = [uuidBytes(id)];
  for (const s of segments) parts.push(Buffer.from([0]), Buffer.from(s, "utf8"));
  return Buffer.concat(parts);
}
