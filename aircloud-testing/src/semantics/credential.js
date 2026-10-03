// @aircloudhq/testing — governed egress and in-process HMAC by opaque credential handle.
//
// THE SECRET NEVER CROSSES INTO THE GUEST (ADR-098 D2): a guest names a handle; the platform
// resolves it, screens the request, injects the secret and dials. The double keeps the same
// boundary — the secret lives in the world, the guest sees only the response — and replaces the
// DIAL with a responder the test registers, because a double that invented an upstream answer
// would make the test pass for a reason the platform does not share.
//
// Mirrored behaviour:
//   * production — control-plane/internal/capgw/egress.go: unsupported method → capability.validation;
//     unknown handle → capability.credential_not_found; revoked → capability.credential_revoked;
//     URL outside the allowlist (https only, exact host or one-label `*.` wildcard, optional :port —
//     control-plane/internal/egress/allowlist.go) → capability.destination_forbidden; a client header
//     equal to the injection header → capability.header_conflict; hop-by-hop headers dropped both
//     ways; the response body is text (v1).
//   * non-production — functions/src/caps_credential.rs egress_capture: no dial, no screening, the
//     synthetic `202 {"captured":true,"capture_id":"<uuid>"}`, and a capture record carrying the
//     destination WITHOUT query or fragment.
//   * hmac-sign / hmac-verify (release runtime spec § Secret custody) — in-process, the key never
//     leaves; verify compares in constant time. Bound to the guest once the WIT carries them.
//   * the hmac key — control-plane/internal/skeleton/keyencoding.go DecodeHMACKey via capgw ReadHMACKey:
//     the stored value decoded by the secret's declared key_encoding (text | base64 | hex |
//     standard-webhooks = `whsec_` stripped, base64-decoded); a value that does not decode is
//     capability.credential_key_invalid, never a different key (#645 DX143).
import { createHmac, timingSafeEqual } from "node:crypto";
import { CONTRACT } from "../../generated/contract-data.js";
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const HOP_BY_HOP = ["connection", "proxy-connection", "keep-alive", "te", "transfer-encoding", "upgrade", "trailer"];
const TYPES = ["bearer", "basic", "header", "hmac"];
const HMAC_ALGORITHMS = { sha256: "sha256", sha512: "sha512" };
const KEY_ENCODINGS = CONTRACT.hmacKeyEncodings.values;
const STANDARD_WEBHOOKS_PREFIX = "whsec_";
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** control-plane/internal/skeleton/keyencoding.go DecodeHMACKey — the key a stored value yields, or null. */
export function decodeHmacKey(encoding, value) {
  let key = null;
  switch (encoding) {
    case "text":
      key = Buffer.from(value, "utf8");
      break;
    case "base64":
      key = BASE64.test(value) ? Buffer.from(value, "base64") : null;
      break;
    case "hex":
      key = value.length % 2 === 0 && /^[0-9A-Fa-f]*$/.test(value) ? Buffer.from(value, "hex") : null;
      break;
    case "standard-webhooks": {
      if (!value.startsWith(STANDARD_WEBHOOKS_PREFIX)) return null;
      const rest = value.slice(STANDARD_WEBHOOKS_PREFIX.length);
      key = BASE64.test(rest) ? Buffer.from(rest, "base64") : null;
      break;
    }
    default:
      throw new DoubleMisuseError(`unknown key encoding '${encoding}'`);
  }
  return key !== null && key.length > 0 ? key : null;
}

function splitHostPortLoose(s) {
  const i = s.lastIndexOf(":");
  if (i >= 0 && !s.slice(i + 1).includes(".") && s.slice(i + 1) !== "") return [s.slice(0, i), s.slice(i + 1)];
  return [s, ""];
}

/** control-plane/internal/egress/allowlist.go DestinationAllowed. */
export function destinationAllowed(rawUrl, allowlist) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "") return false;
  const port = u.port === "" ? "443" : u.port;
  return allowlist.some((raw) => {
    const [entryHost, entryPort] = splitHostPortLoose(raw.trim().toLowerCase());
    if (entryPort !== "" && entryPort !== port) return false;
    if (entryHost.startsWith("*.")) {
      const suffix = entryHost.slice(1);
      if (!host.endsWith(suffix)) return false;
      const label = host.slice(0, host.length - suffix.length);
      return label !== "" && !label.includes(".");
    }
    return entryHost === host;
  });
}

function redactDestination(rawUrl) {
  const i = rawUrl.search(/[?#]/);
  return i >= 0 ? rawUrl.slice(0, i) : rawUrl;
}

function injection(cred) {
  switch (cred.type) {
    case "bearer": return ["Authorization", `Bearer ${cred.secret}`];
    case "basic": return ["Authorization", `Basic ${Buffer.from(`${cred.secret.username}:${cred.secret.password}`).toString("base64")}`];
    case "header": return [cred.header, cred.secret];
    default: return [null, null];
  }
}

export function createCredentialState(world) {
  const creds = new Map();
  const responders = [];
  const calls = [];
  const captures = [];

  function resolve(handle) {
    const c = creds.get(handle);
    if (!c) throw new CapabilityFailure("capability.credential_not_found", "no such credential handle", {});
    if (c.revoked) throw new CapabilityFailure("capability.credential_revoked", "credential handle is revoked", {});
    return c;
  }
  function hmacKey(handle) {
    const c = resolve(handle);
    if (c.type !== "hmac") {
      throw new CapabilityFailure("capability.validation", "credential handle is not an hmac credential", {});
    }
    const key = decodeHmacKey(c.keyEncoding, c.secret);
    if (key === null) {
      throw new CapabilityFailure("capability.credential_key_invalid", "the credential's value does not decode under its declared key encoding", {});
    }
    return key;
  }

  const state = {
    /**
     * Declare a credential the function may reach by handle.
     *   bearer: { secret: "<token>" } · basic: { secret: { username, password } }
     *   header: { secret: "<value>", header: "<name>" } · hmac: { secret: "<value>", keyEncoding? }
     * `allow` is the destination allowlist (host, host:port, *.domain); an hmac credential has none.
     * `keyEncoding` is the secret's declared config/secrets.toml key_encoding (default text): how the
     * value becomes the key, exactly as the platform decodes it.
     */
    define(handle, { type, secret, header, allow = [], keyEncoding = CONTRACT.hmacKeyEncodings.default } = {}) {
      if (typeof handle !== "string" || handle === "") throw new DoubleMisuseError("credential.define: handle must be a non-empty string");
      if (!TYPES.includes(type)) throw new DoubleMisuseError(`credential.define: type must be one of ${TYPES.join(", ")}`);
      if (type === "basic" ? !(secret && secret.username && secret.password) : typeof secret !== "string" || secret === "") {
        throw new DoubleMisuseError(`credential.define: a ${type} credential needs its secret`);
      }
      if (type === "header" && (typeof header !== "string" || header === "")) throw new DoubleMisuseError("credential.define: a header credential needs `header`");
      if (type === "hmac" && allow.length > 0) throw new DoubleMisuseError("credential.define: an hmac credential has no egress");
      if (!KEY_ENCODINGS.includes(keyEncoding)) throw new DoubleMisuseError(`credential.define: keyEncoding must be one of ${KEY_ENCODINGS.join(", ")}`);
      if (type !== "hmac" && keyEncoding !== CONTRACT.hmacKeyEncodings.default) {
        throw new DoubleMisuseError("credential.define: only an hmac credential declares a keyEncoding (an egress secret is injected as its text)");
      }
      creds.set(handle, { handle, type, secret, header, allow: [...allow], keyEncoding, revoked: false });
    },
    revoke(handle) {
      const c = creds.get(handle);
      if (!c) throw new DoubleMisuseError(`credential.revoke: no credential '${handle}'`);
      c.revoked = true;
    },
    /**
     * Answer egress requests. `match` is a handle, a URL prefix, or a predicate over the request;
     * `reply` is { status, headers?, body? } or a function of the request returning one.
     */
    respond(match, reply) {
      responders.push({ match, reply });
    },
    /** Every production egress that reached the (simulated) dial, with the injected header. */
    get calls() { return calls; },
    /** Every non-production capture record. */
    get captures() { return captures; },

    // ── the WIT surface ──────────────────────────────────────────────────────────────────
    egress(req) {
      if (world.linkArm("credential.egress") === "capture") {
        const captureId = world.newId();
        captures.push({ captureId, capability: "credential.egress", destination: redactDestination(req.url), method: req.method });
        return { status: 202, headers: [], body: JSON.stringify({ captured: true, capture_id: captureId }) };
      }
      const method = req.method.toUpperCase();
      if (!ALLOWED_METHODS.includes(method)) throw new CapabilityFailure("capability.validation", "unsupported method", {});
      const cred = resolve(req.handle);
      if (!destinationAllowed(req.url, cred.allow)) throw new CapabilityFailure("capability.destination_forbidden", "destination not permitted", {});
      const [injHeader, injValue] = injection(cred);
      const headers = {};
      for (const [k, v] of req.headers) {
        if (HOP_BY_HOP.includes(k.toLowerCase())) continue;
        if (injHeader && k.toLowerCase() === injHeader.toLowerCase()) {
          throw new CapabilityFailure("capability.header_conflict", "client header collides with the injected credential header", {});
        }
        headers[k] = headers[k] === undefined ? v : `${headers[k]}, ${v}`;
      }
      if (injHeader) headers[injHeader] = injValue;
      const outbound = { handle: req.handle, method, url: req.url, headers, body: req.body };
      calls.push(outbound);
      const r = responders.find(({ match }) =>
        typeof match === "function" ? match(outbound) : match === req.handle || req.url.startsWith(match));
      if (!r) throw new DoubleMisuseError(`no egress responder registered for ${method} ${req.url} (credential.respond)`);
      const res = typeof r.reply === "function" ? r.reply(outbound) : r.reply;
      if (!res || !Number.isInteger(res.status) || res.status < 100 || res.status > 599) {
        throw new DoubleMisuseError("egress responder must return { status: 100..599, headers?, body? }");
      }
      const body = res.body === undefined ? "" : res.body;
      if (typeof body !== "string") throw new DoubleMisuseError("egress responder body must be a string (v1 text-body contract)");
      const pairs = Array.isArray(res.headers) ? res.headers : Object.entries(res.headers || {});
      return { status: res.status, headers: pairs.filter(([k]) => !HOP_BY_HOP.includes(k.toLowerCase())).map(([k, v]) => [k, String(v)]), body };
    },
    hmacSign(handle, algorithm, message) {
      return new Uint8Array(createHmac(HMAC_ALGORITHMS[algorithm], hmacKey(handle)).update(message).digest());
    },
    hmacVerify(handle, algorithm, message, signature) {
      const expected = createHmac(HMAC_ALGORITHMS[algorithm], hmacKey(handle)).update(message).digest();
      const got = Buffer.from(signature.buffer, signature.byteOffset, signature.byteLength);
      return got.length === expected.length && timingSafeEqual(got, expected);
    },
  };
  return state;
}
