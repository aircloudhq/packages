// Locale negotiation (ADR-223 D7; spec S4 § Locale negotiation). The site's order:
//   1. the `locale` query parameter, when it names an available locale;
//   2. reserved for the end-user and organisation preference (#632) — the `preferred` hook;
//   3. navigator.languages (what the browser also sends as Accept-Language), RFC 4647 lookup;
//   4. default_locale.
// Nothing stores the choice outside the URL.

/** The `locale` query parameter of a URL (a string, URL or URLSearchParams). */
export function localeFromUrl(url) {
  if (url === undefined || url === null) return undefined;
  const params = url instanceof URLSearchParams ? url : new URL(String(url), 'http://x').searchParams;
  return params.get('locale') ?? undefined;
}

function canonical(available, tag) {
  const t = String(tag).toLowerCase();
  return available.find((a) => a.toLowerCase() === t);
}

/**
 * RFC 4647 § 3.4 Lookup: for each language range in priority order, the range and then each
 * truncation of it (dropping the last subtag, and a single-character subtag with it) is compared
 * case-insensitively with the available tags; the first hit wins. `*` never matches.
 */
export function lookupLocale(ranges, available) {
  for (const range of ranges ?? []) {
    if (!range || range === '*') continue;
    const subtags = String(range).split('-');
    while (subtags.length > 0) {
      const hit = canonical(available, subtags.join('-'));
      if (hit) return hit;
      subtags.pop();
      if (subtags.length > 0 && subtags[subtags.length - 1].length === 1) subtags.pop();
    }
  }
  return undefined;
}

/** The language ranges of an Accept-Language header, by descending q (ties keep header order). */
export function acceptLanguage(header) {
  if (!header) return [];
  return String(header)
    .split(',')
    .map((part, index) => {
      const [range, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return { range: range.trim(), q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter((r) => r.range && Number.isFinite(r.q) && r.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((r) => r.range);
}

/**
 * The site's locale for a page load.
 * @param {{url?: string|URL|URLSearchParams, languages?: readonly string[], available: string[],
 *          defaultLocale: string, preferred?: () => (string|undefined)}} input
 */
export function negotiateLocale({ url, languages, available, defaultLocale, preferred }) {
  const param = localeFromUrl(url);
  const fromParam = param && canonical(available, param);
  if (fromParam) return fromParam;
  const pref = preferred?.();
  const fromPref = pref && canonical(available, pref);
  if (fromPref) return fromPref;
  return lookupLocale(languages, available) ?? defaultLocale;
}
