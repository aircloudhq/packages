// ActionView::Helpers::UrlHelper at the census commit: url_for, mail_to, sms_to, phone_to. The tag
// helpers return markup (escaped attributes and content, as Rails' tag builder).
//
// **The locale travels in the URL** (ADR-223 D7; spec S4 § Locale negotiation): a same-origin URL
// built while the current page carries a `locale` query parameter carries it forward, as Rails'
// `default_url_options` does. Nothing stores the choice elsewhere.
import { escapeHtml } from '../i18n/index.js';

function currentLocation(options) {
  if (options?.currentUrl) return new URL(String(options.currentUrl), 'http://x');
  if (typeof location !== 'undefined') return new URL(location.href);
  return undefined;
}

/**
 * url_for — a path (or `{path, params, anchor}`) with the current page's `locale` parameter
 * carried forward. An absolute URL to another origin is returned as given.
 */
export function urlFor(target, options = {}) {
  const spec = typeof target === 'string' ? { path: target } : { ...target };
  const here = currentLocation(options);
  const base = here ? here.origin : 'http://x';
  const url = new URL(spec.path ?? '', here ? here.href : 'http://x/');
  if (url.origin !== base && /^[a-z][a-z0-9+.-]*:/i.test(spec.path ?? '')) return spec.path;
  for (const [k, v] of Object.entries(spec.params ?? {})) {
    if (v === undefined || v === null) url.searchParams.delete(k);
    else url.searchParams.set(k, String(v));
  }
  const locale = here?.searchParams.get('locale');
  if (locale && !url.searchParams.has('locale') && options.carryLocale !== false) url.searchParams.set('locale', locale);
  if (spec.anchor) url.hash = spec.anchor;
  return url.pathname + url.search + url.hash;
}

function attributes(html) {
  return Object.entries(html ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${escapeHtml(v)}"`))
    .join('');
}

/** ERB::Util.url_encode: every byte outside [A-Za-z0-9_.~-] percent-encoded. */
export function urlEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

const present = (v) => v !== undefined && v !== null && v !== '';

function split(name, htmlOptions) {
  return typeof name === 'object' && name !== null ? [undefined, name] : [name, htmlOptions ?? {}];
}

/** mail_to "me@domain.com", "My email" # => <a href="mailto:me@domain.com">My email</a> */
export function mailTo(email, name, htmlOptions) {
  const [label, opts] = split(name, htmlOptions);
  const { replyTo, ...rest } = opts;
  const html = { ...rest };
  if (present(replyTo)) html.reply_to = replyTo;
  const extras = ['cc', 'bcc', 'body', 'subject', 'reply_to']
    .filter((k) => present(html[k]))
    .map((k) => `${k.replace('_', '-')}=${urlEncode(html[k])}`);
  for (const k of ['cc', 'bcc', 'body', 'subject', 'reply_to']) delete html[k];
  const href = `mailto:${urlEncode(email).replace(/%40/g, '@')}${extras.length ? '?' + extras.join('&') : ''}`;
  return `<a${attributes({ ...html, href })}>${escapeHtml(label ?? email)}</a>`;
}

/** sms_to "5155555785", "Text me", body: "Hi" # => <a href="sms:5155555785;?&body=Hi">Text me</a> */
export function smsTo(phoneNumber, name, htmlOptions) {
  const [label, opts] = split(name, htmlOptions);
  const { countryCode, country_code, body, ...html } = opts;
  const cc = countryCode ?? country_code;
  const code = present(cc) ? `+${urlEncode(cc)}` : '';
  const b = present(body) ? `?&body=${urlEncode(body)}` : '';
  return `<a${attributes({ ...html, href: `sms:${code}${urlEncode(phoneNumber)};${b}` })}>${escapeHtml(label ?? phoneNumber)}</a>`;
}

/** phone_to "1234567890", "Call me" # => <a href="tel:1234567890">Call me</a> */
export function phoneTo(phoneNumber, name, htmlOptions) {
  const [label, opts] = split(name, htmlOptions);
  const { countryCode, country_code, ...html } = opts;
  const cc = countryCode ?? country_code;
  const code = cc === undefined || cc === null ? '' : `+${urlEncode(cc)}`;
  return `<a${attributes({ ...html, href: `tel:${code}${urlEncode(phoneNumber)}` })}>${escapeHtml(label ?? phoneNumber)}</a>`;
}

export { attributes as htmlAttributes };
