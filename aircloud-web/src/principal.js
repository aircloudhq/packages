// @aircloudhq/web/principal — the end user of a `session` route, its flash and its CSRF proof, for a
// JavaScript function (#632 ADR-241 decision 4, plan W15.4/W15.7; the Rails `current_user`-shaped
// principal, `flash` and `csrf_meta_tags`, ADR-221 D4).
//
// The web-origin holds the end-user session; the function never sees the session cookie or a token.
// The functions host hands the guest what the platform asserted, through the
// `aircloud:functions/principal` interface, and this module reads it:
//
//   import { principal, flash, setFlash, csrfMeta } from '@aircloudhq/web/principal';
//   const me = principal();           // null on a public route
//   const { notice } = flash();       // the message the previous request set (read once)
//   setFlash({ notice: 'Saved' });    // the next request's message
//   `<head>${csrfMeta()}</head>`      // the token a form or fetch sends as X-CSRF-Token
//
// The CSRF check is the session edge's (the web-origin): an unsafe request is accepted when its
// `Origin` is the product's, and a client that sends no `Origin` proves it with the session's token.
import { csrfToken as wireCsrf, current, flash as wireFlash, setFlash as wireSetFlash } from 'aircloud:functions/principal@1.0.0';

const escapeAttr = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The end user this invocation serves, or null outside a `session` route.
 * @returns {{sub: string, tenantId: string, orgPath: string, roles: string[], act: object|null}|null}
 */
export function principal() {
  const p = current();
  if (!p) return null;
  return { sub: p.sub, tenantId: p.tenantId, orgPath: p.orgPath, roles: [...p.roles], act: p.act ? JSON.parse(p.act) : null };
}

/** The flash the previous request of this session set (`{}` when none) — the platform clears it. */
export function flash() {
  const f = wireFlash();
  if (!f) return {};
  try {
    return JSON.parse(f);
  } catch {
    return { notice: f }; // a flash a container set as plain text
  }
}

/** Set the flash the next request of this session reads (an object, stored as JSON). */
export function setFlash(message) {
  wireSetFlash(JSON.stringify(message));
}

/** The session's CSRF token, or null outside a `session` route. */
export function csrfToken() {
  return wireCsrf() ?? null;
}

/** The Rails `csrf_meta_tags` pair carrying the session's token; empty outside a session. */
export function csrfMeta() {
  const t = csrfToken();
  if (!t) return '';
  return `<meta name="csrf-param" content="authenticity_token" />\n<meta name="csrf-token" content="${escapeAttr(t)}" />`;
}
