// @aircloudhq/web/assertion — a CONTAINER's verification of the platform principal assertion (#632
// ADR-241 decision 4). The web-origin holds the end-user session; an authenticated request reaches the
// Builder's container with `x-air-principal`, an ES256 JWS the platform signed under its dedicated
// `web-origin-principal` key, and never the session cookie or a token. The container verifies it here
// with the same semantics as the functions-host route trigger (functions/src/caps_principal.rs):
//
//   import { verifyPrincipal } from '@aircloudhq/web/assertion';
//   const me = await verifyPrincipal(request);  // throws on anything but a valid assertion
//
// Checked: alg ES256 under a key of the principal key set (`jwksFile` — default AIR_PRINCIPAL_JWKS_FILE,
// the file the platform projects into every container from the key set its control plane reconciles into
// the tenant namespace; a container never fetches it, so it needs no path to a platform API), the issuer,
// `aud` = the product host the request names, `tenant_id` = this product's tenant (default
// AIR_TENANT_ID), a lifetime of at most 60 s that has not ended, and a well-formed principal. A rotation
// rewrites the file: an assertion naming a kid the cached set lacks re-reads it once. Fail-closed: a
// missing setting, an absent or malformed key set or any mismatch throws.

import { readFile } from 'node:fs/promises';

export const PRINCIPAL_HEADER = 'x-air-principal';
export const PRINCIPAL_ISSUER = 'aircloud-web-origin-principal';
/** == functions/src/caps_principal.rs MAX_ASSERTION_LIFETIME_SECS / ASSERTION_CLOCK_SKEW_SECS. */
const MAX_LIFETIME_SECS = 60;
const CLOCK_SKEW_SECS = 5;
const JWKS_MAX_AGE_MS = 300_000;

const cache = new Map(); // jwksFile → { keys, at }

const env = (k) => (typeof process !== 'undefined' && process.env ? process.env[k] : undefined);

function b64uDecode(s) {
  return Uint8Array.from(Buffer.from(s, 'base64url'));
}

function parse(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new Error('the principal assertion is not a compact JWS');
  const [h, p, s] = parts;
  const json = (seg) => JSON.parse(new TextDecoder().decode(b64uDecode(seg)));
  return { header: json(h), claims: json(p), input: new TextEncoder().encode(`${h}.${p}`), sig: b64uDecode(s) };
}

async function readKeySet(file, now) {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  if (!doc || !Array.isArray(doc.keys)) throw new Error(`the principal key set ${file} is not a JWK set`);
  cache.set(file, { keys: doc.keys, at: now });
  return doc.keys;
}

/** The key `kid` of the set at `file`: cached, re-read when stale or when the cached set lacks the kid. */
async function keyFor(file, kid, now) {
  const hit = cache.get(file);
  const fresh = hit && now - hit.at < JWKS_MAX_AGE_MS;
  let found = fresh ? hit.keys.find((k) => k.kid === kid) : undefined;
  if (!found) found = (await readKeySet(file, now)).find((k) => k.kid === kid);
  if (!found) throw new Error(`no principal key '${kid}' in ${file}`);
  return found;
}

const text = (v, what) => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error(`the assertion's ${what} is not text`);
  return v;
};

/**
 * Verify the platform principal assertion of `request` (a Fetch API Request, or headers) and return the
 * end user it asserts.
 * @param {Request|{headers: Headers}} request
 * @param {{jwksFile?: string, tenantId?: string, issuer?: string, host?: string, now?: () => number}} [options]
 * @returns {Promise<{sub: string, tenantId: string, orgPath: string, roles: string[], act: object|null, flash: string|null, csrf: string|null}>}
 */
export async function verifyPrincipal(request, options = {}) {
  const jwksFile = options.jwksFile ?? env('AIR_PRINCIPAL_JWKS_FILE');
  const tenantId = options.tenantId ?? env('AIR_TENANT_ID');
  const issuer = options.issuer ?? PRINCIPAL_ISSUER;
  const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();
  if (!jwksFile) throw new Error('verifyPrincipal: no key-set file (AIR_PRINCIPAL_JWKS_FILE) — refusing (fail-closed)');
  if (!tenantId) throw new Error('verifyPrincipal: no tenant (AIR_TENANT_ID) — refusing (fail-closed)');
  const headers = request.headers;
  const host = (options.host ?? headers.get('x-forwarded-host') ?? headers.get('host') ?? '').toLowerCase();
  const token = headers.get(PRINCIPAL_HEADER);
  if (!token) throw new Error('the request carries no principal assertion');

  const { header, claims: c, input, sig } = parse(token);
  if (header.alg !== 'ES256' || typeof header.kid !== 'string') throw new Error('the assertion is not ES256 with a kid');
  const jwk = await keyFor(jwksFile, header.kid, now * 1000);
  const { kid, alg, use, key_ops: _ops, ...material } = jwk;
  const pub = await crypto.subtle.importKey('jwk', material, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, input);
  if (!ok) throw new Error('the assertion does not verify');

  if (c.iss !== issuer) throw new Error('the assertion names another issuer');
  if (!host || c.aud !== host) throw new Error('the assertion is for another product host');
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp) || c.exp <= c.iat || c.exp - c.iat > MAX_LIFETIME_SECS) {
    throw new Error('the assertion lifetime is out of bounds');
  }
  if (now >= c.exp) throw new Error('the assertion has expired');
  if (Math.max(c.iat, c.nbf ?? 0) > now + CLOCK_SKEW_SECS) throw new Error('the assertion is not valid yet');
  if (c.tenant_id !== tenantId) throw new Error('the assertion is for another tenant');
  if (typeof c.org_path !== 'string' || !c.org_path.startsWith('/')) throw new Error('the assertion carries no org_path');
  if (typeof c.sub !== 'string' || c.sub === '') throw new Error('the assertion carries no sub');
  const roles = c.roles ?? [];
  if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string')) throw new Error("the assertion's roles are not strings");
  return {
    sub: c.sub,
    tenantId: c.tenant_id,
    orgPath: c.org_path,
    roles,
    act: c.act ?? null,
    flash: text(c.flash, 'flash'),
    csrf: text(c.csrf, 'csrf'),
  };
}
