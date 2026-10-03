// The i18n runtime (ADR-223 D6; spec S4 § Translation semantics): `t`, `l`, number formatting and
// `pluralize` over a locale bundle (contracts/deploy/v1/locale-bundle-v1.json) and NOTHING else —
// never the host's Intl or time-zone database (D4). Every behaviour here is pinned by the shared
// vectors (contracts/deploy/v1/i18n-vectors.json), which the Rust function runtime runs too.
import { abs, delimit, parseDecimal, roundFixed, roundSignificant } from './decimal.js';
import { pluralCategory } from './plural.js';
import { civilFromDays, daysFromCivil, floorDiv, weekdayOf } from './civil.js';
import { strftime } from './strftime.js';
import { zoneAt } from './zone.js';

export { pluralCategory, operands } from './plural.js';
export { zoneAt } from './zone.js';
export { negotiateLocale, lookupLocale, acceptLanguage, localeFromUrl } from './negotiate.js';
export { createMissingReporter } from './missing.js';

/** The locale that ends every run-time chain with the platform defaults (S4 § [i18n]). */
export const PLATFORM_TERMINAL_LOCALE = 'en';

const PLURAL_KEYS = ['zero', 'one', 'two', 'few', 'many', 'other'];
const OPTION_KEYS = new Set(['scope', 'default', 'count', 'lazy', 'context', 'locale']);

// ── chains ───────────────────────────────────────────────────────────────────────────────────

/** The run-time chain: the locale, its declared fallbacks, default_locale, then `en`. */
export function runtimeChain(bundle, locale) {
  return unique([locale, ...(bundle.fallbacks?.[locale] ?? []), bundle.default_locale, PLATFORM_TERMINAL_LOCALE]);
}

/** The locale and its declared fallbacks — where names, number symbols and inflections resolve. */
export function declaredChain(bundle, locale) {
  return unique([locale, ...(bundle.fallbacks?.[locale] ?? [])]);
}

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function dig(tree, parts) {
  let cur = tree;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function parts(key) {
  return String(key).split('.').filter((s) => s !== '');
}

function firstIn(bundle, locales, key, accept = (v) => v !== undefined && v !== null) {
  for (const loc of locales) {
    const v = dig(bundle.messages?.[loc], parts(key));
    if (accept(v)) return { value: v, locale: loc };
  }
  return undefined;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── keys ─────────────────────────────────────────────────────────────────────────────────────

/** The key scope of a lazy lookup: a site page path or a function name (S4 § Locale files). */
export function lazyScope(lazy) {
  if (!lazy) return undefined;
  if (lazy.site_page) {
    const p = lazy.site_page.replace(/^(app\/site\/)?(src\/)?pages\//, '').replace(/\.(jsx|js)$/, '');
    return p.split('/').filter(Boolean).join('.');
  }
  if (lazy.function) return `functions.${lazy.function}`;
  return undefined;
}

/** A key with its scope and lazy prefix applied. */
export function expandKey(key, { scope, lazy } = {}) {
  const k = String(key);
  if (k.startsWith('.')) {
    const s = lazyScope(lazy);
    if (!s) throw new Error(`t("${k}"): a lazy key needs a page or function scope`);
    return `${s}${k}`;
  }
  const sc = Array.isArray(scope) ? scope.join('.') : scope;
  return sc ? `${sc}.${k}` : k;
}

/** Rails' humanize of the last key segment — the published rendering of a missing key (D10). */
export function humanizeKey(key) {
  const seg = parts(key).pop() ?? String(key);
  let s = seg.replace(/^_+/, '');
  if (s.endsWith('_id')) s = s.slice(0, -3);
  s = s.replace(/_/g, ' ').replace(/[A-Za-z0-9]+/g, (w) => w.toLowerCase()).trim();
  return s.replace(/^[a-z]/, (c) => c.toUpperCase());
}

// ── t ────────────────────────────────────────────────────────────────────────────────────────

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** ERB::Util.html_escape. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Whether a key's translation may carry markup (Rails: the key ends in `_html` or `.html`). */
export function isHtmlKey(key) {
  return /(?:_|\.|^)html$/.test(String(key));
}

/** `%{name}` interpolation; `%%` is a literal percent; a missing argument keeps its placeholder. */
export function interpolate(text, args, escape = (v) => String(v)) {
  return String(text).replace(/%%|%\{([^}]+)\}/g, (m, name) => {
    if (m === '%%') return '%';
    return Object.prototype.hasOwnProperty.call(args, name) && args[name] !== undefined ? escape(args[name]) : m;
  });
}

function pluralize(bundle, locale, entry, count) {
  if (!isObject(entry) || !PLURAL_KEYS.some((k) => k in entry)) return entry;
  if (Number(parseFloat(String(count))) === 0 && 'zero' in entry) return entry.zero;
  const cats = bundle.cldr?.[locale]?.plurals;
  const cat = cats ? pluralCategory(cats, count) : 'other';
  return cat in entry ? entry[cat] : entry.other;
}

/**
 * Resolve a translation: per locale of the run-time chain, the key then its key defaults; a literal
 * default only after the whole chain (Rails' Fallbacks backend).
 * @returns {{found: true, value: any, literal?: boolean} | {found: false, key: string}}
 */
export function resolve(bundle, locale, key, options = {}) {
  const fullKey = expandKey(key, options);
  const defaults = options.default === undefined ? [] : Array.isArray(options.default) ? options.default : [options.default];
  const keyDefaults = defaults.filter(isObject).map((d) => expandKey(d.key, options));
  const literal = defaults.find((d) => typeof d === 'string');
  for (const loc of runtimeChain(bundle, locale)) {
    for (const k of [fullKey, ...keyDefaults]) {
      let v = dig(bundle.messages?.[loc], parts(k));
      if (v === undefined || v === null) continue;
      if (options.count !== undefined) v = pluralize(bundle, loc, v, options.count);
      if (v === undefined || v === null) continue;
      return { found: true, value: v, key: fullKey };
    }
  }
  if (literal !== undefined) return { found: true, value: literal, literal: true, key: fullKey };
  return { found: false, key: fullKey };
}

/**
 * `t`: the rendered translation in the output context (`html` escapes interpolated values, and the
 * translation text unless the key may carry markup; `text` and `json` escape nothing).
 */
export function translate(bundle, locale, key, options = {}, report = () => {}) {
  const context = options.context ?? 'text';
  const args = {};
  for (const [k, v] of Object.entries(options)) if (!OPTION_KEYS.has(k)) args[k] = v;
  if (options.count !== undefined) args.count = options.count;
  const r = resolve(bundle, locale, key, options);
  if (!r.found) {
    report(r.key);
    const h = humanizeKey(r.key);
    return context === 'html' ? escapeHtml(h) : h;
  }
  if (typeof r.value !== 'string') return r.value;
  if (context !== 'html') return interpolate(r.value, args);
  if (isHtmlKey(r.key)) return interpolate(r.value, args, escapeHtml);
  return escapeHtml(interpolate(r.value, args));
}

// ── l ────────────────────────────────────────────────────────────────────────────────────────

const CIVIL = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The locale's value for a name kind: its declared chain's messages, then its CLDR data. */
function nameSource(bundle, locale) {
  const keys = {
    day_names: 'date.day_names', abbr_day_names: 'date.abbr_day_names',
    month_names: 'date.month_names', abbr_month_names: 'date.abbr_month_names',
    am: 'time.am', pm: 'time.pm',
  };
  return (kind) => {
    const hit = firstIn(bundle, declaredChain(bundle, locale), keys[kind]);
    if (hit) return hit.value;
    const cldr = bundle.cldr?.[locale]?.dates?.[kind];
    if (cldr !== undefined) return cldr;
    throw new Error(`no ${kind} for ${locale} in the bundle`);
  };
}

/** Break a value down to local time: a civil date string, or an instant rendered in `zone`. */
export function brokenDown(bundle, value, zoneName) {
  if (typeof value === 'string' && CIVIL.test(value)) {
    const [, y, m, d] = CIVIL.exec(value).map(Number);
    return { kind: 'date', year: y, month: m, day: d, hour: 0, minute: 0, second: 0, wday: weekdayOf(daysFromCivil(y, m, d)), offset: null, abbr: null };
  }
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`l: not a date or time: ${value}`);
  const name = zoneName ?? bundle.time_zone;
  const zone = bundle.zones?.[name];
  if (!zone) throw new Error(`l: the bundle carries no rules for the zone ${name}`);
  const at = Math.floor(ms / 1000);
  const lt = zoneAt(zone, at);
  const local = at + lt.offset;
  const days = floorDiv(local, 86400);
  const [year, month, day] = civilFromDays(days);
  const sod = local - days * 86400;
  return {
    kind: 'time', year, month, day,
    hour: Math.floor(sod / 3600), minute: Math.floor((sod % 3600) / 60), second: sod % 60,
    wday: weekdayOf(days), offset: lt.offset, abbr: lt.abbr,
  };
}

/** `l`: a date or time in a named format (date.formats / time.formats) or a strftime string. */
export function localize(bundle, locale, value, options = {}, report = () => {}) {
  const t = brokenDown(bundle, value, options.zone);
  const format = options.format ?? 'default';
  let pattern = format;
  if (!String(format).includes('%')) {
    const key = `${t.kind}.formats.${format}`;
    const hit = firstIn(bundle, runtimeChain(bundle, locale), key, (v) => typeof v === 'string');
    if (!hit) {
      report(key);
      return humanizeKey(key);
    }
    pattern = hit.value;
  }
  return strftime(pattern, t, nameSource(bundle, locale));
}

// ── numbers ──────────────────────────────────────────────────────────────────────────────────

/** ActiveSupport::NumberHelper::NumberConverter::DEFAULTS. */
export const NUMBER_DEFAULTS = {
  format: { separator: '.', delimiter: ',', precision: 3, significant: false, strip_insignificant_zeros: false },
  currency: { format: '%u%n', negative_format: '-%u%n', unit: '$', separator: '.', delimiter: ',', precision: 2, significant: false, strip_insignificant_zeros: false },
  percentage: { delimiter: '', format: '%n%' },
  precision: { delimiter: '' },
  human: {
    delimiter: '', precision: 3, significant: true, strip_insignificant_zeros: true,
    units: { billion: 'Billion', million: 'Million', quadrillion: 'Quadrillion', thousand: 'Thousand', trillion: 'Trillion', unit: '' },
  },
  storage_units: { format: '%n %u', units: { byte: 'Bytes', kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB', pb: 'PB', eb: 'EB', zb: 'ZB' } },
};

/**
 * The effective options of a number style (Rails' i18n_format_options): defaults, then the first
 * `number.format` hash of the locale's declared chain (else its CLDR symbols), then the first
 * `number.<namespace>.format` hash of the run-time chain, then the call's options.
 */
export function numberOptions(bundle, locale, namespace, options = {}) {
  const base = firstIn(bundle, declaredChain(bundle, locale), 'number.format', isObject)?.value
    ?? cldrNumberFormat(bundle, locale)
    ?? firstIn(bundle, runtimeChain(bundle, locale), 'number.format', isObject)?.value
    ?? {};
  const ns = namespace ? firstIn(bundle, runtimeChain(bundle, locale), `number.${namespace}.format`, isObject)?.value ?? {} : {};
  return { ...NUMBER_DEFAULTS.format, ...(namespace ? NUMBER_DEFAULTS[namespace] ?? {} : {}), ...base, ...ns, ...options };
}

function cldrNumberFormat(bundle, locale) {
  const n = bundle.cldr?.[locale]?.numbers;
  return n ? { separator: n.decimal, delimiter: n.group } : undefined;
}

/** number_with_delimiter over the given options. */
export function formatDelimited(value, o) {
  const d = parseDecimal(value);
  return `${d.neg ? '-' : ''}${delimit(d.int, o.delimiter)}${d.frac ? o.separator + d.frac : ''}`;
}

/** number_with_precision over the given options (half-up rounding, BigDecimal's). */
export function formatRounded(value, o) {
  const d = parseDecimal(value);
  const precision = Number(o.precision);
  let r = o.significant && precision > 0 ? roundSignificant(d, precision) : roundFixed(d, precision);
  let frac = r.frac;
  if (o.strip_insignificant_zeros) frac = frac.replace(/0+$/, '');
  return `${r.neg ? '-' : ''}${delimit(r.int, o.delimiter)}${frac ? o.separator + frac : ''}`;
}

/** The shared number styles: currency | delimited | precision | percentage. */
export function formatNumber(bundle, locale, style, value, options = {}) {
  switch (style) {
    case 'delimited':
      return formatDelimited(value, numberOptions(bundle, locale, null, options));
    case 'precision':
      return formatRounded(value, numberOptions(bundle, locale, 'precision', options));
    case 'percentage': {
      const o = numberOptions(bundle, locale, 'percentage', options);
      return o.format.replace('%n', formatRounded(value, o));
    }
    case 'currency': {
      const o = numberOptions(bundle, locale, 'currency', options);
      const d = parseDecimal(value);
      const rounded = formatRounded(abs(d), o);
      const zero = /^[^1-9]*$/.test(rounded);
      const format = d.neg && !zero ? o.negative_format : o.format;
      return format.replace('%n', rounded).replace('%u', o.unit);
    }
    default:
      throw new Error(`formatNumber: unknown style ${style}`);
  }
}

// ── pluralize ────────────────────────────────────────────────────────────────────────────────

/** A word's plural under the locale's inflections (its declared chain), Active Support's way. */
export function inflectPlural(bundle, locale, word) {
  if (!word) return word;
  const inf = firstIn(bundle, declaredChain(bundle, locale), 'inflections', isObject)?.value;
  if (!inf) return word;
  const lower = word.toLowerCase();
  // Active Support: /\b<word>\Z/i — the uncountable word ends the string after a word boundary.
  for (const u of inf.uncountable ?? []) {
    const ul = String(u).toLowerCase();
    if (lower === ul || (lower.endsWith(ul) && /[^a-z0-9_]/.test(lower[lower.length - ul.length - 1] ?? ''))) return word;
  }
  for (const [singular, plural] of inf.irregular ?? []) {
    // The irregular plural is already plural (Rails adds a rule for it too).
    if (lower.endsWith(String(plural).toLowerCase())) return word;
    if (lower.endsWith(String(singular).toLowerCase())) {
      const at = word.length - singular.length;
      const head = word[at];
      const tail = String(plural);
      return word.slice(0, at) + (head === head.toUpperCase() && head !== head.toLowerCase() ? tail[0].toUpperCase() : tail[0]) + tail.slice(1);
    }
  }
  const rules = inf.plural ?? [];
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    const [pattern, replacement] = rules[i];
    const re = new RegExp(pattern, 'iu');
    if (re.test(word)) return word.replace(re, String(replacement).replace(/\\(\d)/g, '$$$1'));
  }
  return word;
}

/** TextHelper#pluralize: the singular for a count of 1 (or 1.0…), else the plural. */
export function pluralizeWord(bundle, locale, count, singular, plural) {
  const one = count === 1 || /^1(\.0+)?$/.test(String(count));
  const word = one ? singular : plural ?? inflectPlural(bundle, locale, singular);
  return `${count ?? 0} ${word}`;
}

// ── the instance ─────────────────────────────────────────────────────────────────────────────

/**
 * An i18n instance bound to a bundle and a locale.
 * @param {{bundle: object, locale?: string, reporter?: (key: string) => void, lazy?: object}} init
 */
export function createI18n({ bundle, locale, reporter, lazy } = {}) {
  if (!bundle || bundle.version !== 1) throw new Error('createI18n: a locale bundle v1 is required');
  const current = locale && bundle.available_locales.includes(locale) ? locale : bundle.default_locale;
  const report = reporter ?? (() => {});
  const self = {
    bundle,
    locale: current,
    t: (key, options = {}) => translate(bundle, current, key, { lazy, ...options }, report),
    l: (value, options = {}) => localize(bundle, current, value, options, report),
    formatNumber: (style, value, options) => formatNumber(bundle, current, style, value, options),
    numberOptions: (namespace, options) => numberOptions(bundle, current, namespace, options),
    pluralize: (count, singular, plural) => pluralizeWord(bundle, current, count, singular, plural),
    exists: (key, options = {}) => resolve(bundle, current, key, { lazy, ...options }).found,
    /** The raw value of a key through the run-time chain (a hash, an array, a string), or undefined. */
    lookup: (key, options = {}) => {
      const r = resolve(bundle, current, key, { lazy, ...options });
      return r.found ? r.value : undefined;
    },
    /** The raw value of a key through the locale and its declared fallbacks only. */
    lookupDeclared: (key) => firstIn(bundle, declaredChain(bundle, current), key)?.value,
    withLocale: (other) => createI18n({ bundle, locale: other, reporter, lazy }),
    withLazy: (scope) => createI18n({ bundle, locale: current, reporter, lazy: scope }),
  };
  return self;
}
