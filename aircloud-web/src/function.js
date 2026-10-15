// @aircloudhq/web/function — the i18n binding of a JavaScript function (ADR-223 D3, D7; spec S4
// § Locale negotiation, functions; § Run time). A function does not carry the locale bundle: the
// functions host serves the bundle of the release the invocation resolved to through the
// `aircloud:functions/i18n` capability, and this module turns it into the same `t` / `l` / number /
// `pluralize` runtime the site uses (./i18n), so a function answers exactly as its site renders.
//
//   import { i18nFor } from '@aircloudhq/web/function';
//   const i18n = await i18nFor(request, { function: 'greet' });
//   i18n.t('.title'); // functions.greet.title in the negotiated locale
//
// A user-facing error is a code and its details, never a sentence (#250 operator decision D37):
//
//   return errorResponse(request, 409, { code: 'slot_taken', details: { slot } }, { function: 'book' });
//
// answers the platform envelope {"error":{"code","message","correlation_id","details"}} whose message is the
// code's translation in the caller's locale — the function's own functions.<name>.errors.<code>, else the
// platform's errors.codes.<code> — interpolated from the details' scalar values. It accepts nothing else:
// a string, a message or any other key is a TypeError, so free text cannot reach an end user.
//
// Negotiation, in S4's order: (1) the end-user and organisation preference — reserved for #632;
// (2) the request's Accept-Language, RFC 4647 lookup; (3) for a trigger without a request (an
// `x-air-trigger: event` delivery), the `locale` key of the event payload; (4) default_locale. The
// URL's `locale` parameter is a site concern and is never read here.
//
// A bundle the host cannot resolve is not defaulted: `locales()` / `bundle()` throw the capability's
// ComponentError (payload.code `functions.locale_bundle_unresolvable`) and it reaches the function.
// A key no locale resolves renders humanized and is reported through the capability, which alarms
// once per key per release.
import { bundle, keyMissing, locales } from 'aircloud:functions/i18n@1.0.0';
import { acceptLanguage, createI18n, lookupLocale, OPTION_KEYS } from './i18n/index.js';

function canonical(available, tag) {
  if (typeof tag !== 'string') return undefined;
  const t = tag.toLowerCase();
  return available.find((a) => a.toLowerCase() === t);
}

/**
 * The locale of a function invocation.
 * @param {{default_locale: string, available_locales: string[]}} header the bundle header
 * @param {{acceptLanguage?: string|null, trigger?: string|null, payload?: any}} input
 */
export function negotiateFunctionLocale(header, { acceptLanguage: al, trigger, payload } = {}) {
  const available = header.available_locales;
  const fromHeader = al ? lookupLocale(acceptLanguage(al), available) : undefined;
  if (fromHeader) return fromHeader;
  if (trigger === 'event') {
    const fromEvent = canonical(available, payload?.data?.locale);
    if (fromEvent) return fromEvent;
  }
  return header.default_locale;
}

/**
 * The i18n runtime of one invocation: the negotiated locale and the release's bundle for it.
 * @param {Request} request the invocation's request (for a trigger, its delivery)
 * @param {{function?: string}} [options] the function's name, the scope of its lazy keys
 */
export async function i18nFor(request, { function: name } = {}) {
  const header = JSON.parse(locales());
  const trigger = request.headers.get('x-air-trigger');
  let payload;
  if (trigger === 'event') {
    try {
      payload = await request.clone().json();
    } catch {
      payload = undefined; // a delivery that is not JSON carries no locale
    }
  }
  const locale = negotiateFunctionLocale(header, { acceptLanguage: request.headers.get('accept-language'), trigger, payload });
  const reported = new Set();
  return createI18n({
    bundle: JSON.parse(bundle(locale)),
    locale,
    lazy: name ? { function: name } : undefined,
    reporter: (key) => {
      if (reported.has(key)) return;
      reported.add(key);
      keyMissing(locale, key);
    },
  });
}

/** An error code: dot-separated snake_case segments (`slot_taken`, `flex.validation`). */
const CODE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

/** The user-facing error, checked: exactly {code, details?}, a code that is a code, details an object. */
function userError(error) {
  if (!isPlainObject(error)) throw new TypeError('errorResponse: the error is {code, details}, never a message');
  for (const k of Object.keys(error)) {
    if (k !== 'code' && k !== 'details') throw new TypeError(`errorResponse: the error takes only {code, details}, not \`${k}\``);
  }
  if (typeof error.code !== 'string' || !CODE.test(error.code)) {
    throw new TypeError(`errorResponse: ${JSON.stringify(error.code)} is not an error code (snake_case segments)`);
  }
  const details = error.details ?? {};
  if (!isPlainObject(details)) throw new TypeError('errorResponse: details is an object');
  return { code: error.code, details };
}

/**
 * The response of a user-facing error (D37): the platform envelope with the code's translated message.
 * @param {Request} request the invocation's request (its locale, its x-correlation-id)
 * @param {number} status the HTTP status
 * @param {{code: string, details?: object}} error the code and its details — nothing else
 * @param {{function?: string}} [options] the function's name, the scope of its own error keys
 * @returns {Promise<Response>}
 */
export async function errorResponse(request, status, error, { function: name } = {}) {
  const { code, details } = userError(error);
  let message;
  try {
    const i18n = await i18nFor(request, { function: name });
    const args = {};
    for (const [k, v] of Object.entries(details)) {
      if (!OPTION_KEYS.has(k) && ['string', 'number', 'boolean'].includes(typeof v)) args[k] = v;
    }
    const platform = `errors.codes.${code}`;
    message = name ? i18n.t(`.errors.${code}`, { ...args, default: [{ key: platform }] }) : i18n.t(platform, args);
  } catch (e) {
    // An error response is always answered: when the bundle cannot be read, the message is the refusal's code.
    if (typeof e?.payload?.code !== 'string') throw e;
    message = e.payload.code;
  }
  const correlationId = request.headers.get('x-correlation-id') ?? '';
  return new Response(JSON.stringify({ error: { code, message, correlation_id: correlationId, details } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
