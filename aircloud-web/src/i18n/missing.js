// The site's run-time missing-key report (spec S4 § Run time; ADR-223 D10): a key composed at run time
// that is still unresolved after its chain is rendered humanized, and reported to the product host at
// `POST /_air/i18n-missing` as `{release, locale, key}` — at most once per key per page load (the
// lifetime of one reporter), and at most MAX_KEYS_PER_PAGE_LOAD keys, so a page composing keys from
// unbounded data cannot turn into a report per render.

export const MISSING_REPORT_PATH = '/_air/i18n-missing';
export const MAX_KEYS_PER_PAGE_LOAD = 100;

/**
 * @param {{release: string, locale: string, send?: (path: string, body: string) => void}} init
 *   `send` defaults to navigator.sendBeacon (a report never delays or fails the page).
 * @returns {(key: string) => void}
 */
export function createMissingReporter({ release, locale, send }) {
  const seen = new Set();
  const transport =
    send ??
    ((path, body) => {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(path, new Blob([body], { type: 'application/json' }));
      } else if (typeof fetch === 'function') {
        fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
      }
    });
  return (key) => {
    if (seen.has(key) || seen.size >= MAX_KEYS_PER_PAGE_LOAD) return;
    seen.add(key);
    try {
      transport(MISSING_REPORT_PATH, JSON.stringify({ release, locale, key }));
    } catch {
      // a report is best-effort: the rendering already degraded, the page must not
    }
  };
}

const FORMAT_KEY = /^(date|time)\.formats\.(.+)$/;

/** The rule a missing date/time format breaks (#664 item 28): an instant reads time.formats, a civil date date.formats. */
function formatHint(key) {
  const m = FORMAT_KEY.exec(key);
  if (!m) return '';
  const [, kind, name] = m;
  return kind === 'time'
    ? ` A Date or a timestamp is an instant and reads time.formats.${name}; pass a civil date as "YYYY-MM-DD" to read date.formats.${name}.`
    : ` A "YYYY-MM-DD" string is a civil date and reads date.formats.${name}; an instant (a Date) reads time.formats.${name}.`;
}

/**
 * The reporter of a page with no release to report to (a dev server, a preview, a test): a key still
 * unresolved after its chain is rendered humanized and warned on the console — never silently — once per
 * key per page load (at most MAX_KEYS_PER_PAGE_LOAD keys); a missing date/time format names the
 * instant-vs-civil-date rule.
 * @param {{locale: string, warn?: (message: string) => void}} init  `warn` defaults to console.warn
 * @returns {(key: string) => void}
 */
export function createDevReporter({ locale, warn }) {
  const seen = new Set();
  const out = warn ?? ((message) => console.warn(message));
  return (key) => {
    if (seen.has(key) || seen.size >= MAX_KEYS_PER_PAGE_LOAD) return;
    seen.add(key);
    out(`@aircloudhq/web i18n: missing "${key}" (locale ${locale}) — rendered humanized.${formatHint(key)}`);
  };
}
