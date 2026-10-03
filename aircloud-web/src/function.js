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
import { acceptLanguage, createI18n, lookupLocale } from './i18n/index.js';

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
