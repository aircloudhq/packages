// ActionView::Helpers::NumberHelper (ActiveSupport::NumberHelper) at the census commit, over the
// locale bundle's `number.*` keys: the same option names (camelCase accepted as well), the same
// defaults, BigDecimal half-up rounding. Without a bound i18n instance the Rails defaults apply.
import { i18nFor } from '../i18n/current.js';
import { NUMBER_DEFAULTS, formatDelimited, formatRounded } from '../i18n/index.js';
import { abs, parseDecimal } from '../i18n/decimal.js';

const SNAKE = {
  stripInsignificantZeros: 'strip_insignificant_zeros',
  negativeFormat: 'negative_format',
  areaCode: 'area_code',
  countryCode: 'country_code',
  delimiterPattern: 'delimiter_pattern',
};

function snake(options = {}) {
  const out = {};
  for (const [k, v] of Object.entries(options)) if (k !== 'i18n') out[SNAKE[k] ?? k] = v;
  return out;
}

function optionsFor(namespace, options) {
  const o = snake(options);
  const i = i18nFor(options);
  if (i) return i.numberOptions(namespace, o);
  return { ...NUMBER_DEFAULTS.format, ...(namespace ? NUMBER_DEFAULTS[namespace] ?? {} : {}), ...o };
}

function lookup(options, key) {
  return i18nFor(options)?.lookup(key);
}

/** number_to_currency(1234567890.50) # => "$1,234,567,890.50" */
export function numberToCurrency(number, options = {}) {
  const o = optionsFor('currency', options);
  const d = parseDecimal(number);
  const rounded = formatRounded(abs(d), o);
  const format = d.neg && /[1-9]/.test(rounded) ? o.negative_format : o.format;
  return format.replace('%n', rounded).replace('%u', o.unit);
}

/** number_with_delimiter(12345678) # => "12,345,678" */
export function numberWithDelimiter(number, options = {}) {
  return formatDelimited(number, optionsFor(null, options));
}

/** number_with_precision(111.2345) # => "111.235" */
export function numberWithPrecision(number, options = {}) {
  return formatRounded(number, optionsFor('precision', options));
}

/** number_to_percentage(100) # => "100.000%" */
export function numberToPercentage(number, options = {}) {
  const o = optionsFor('percentage', options);
  return o.format.replace('%n', formatRounded(number, o));
}

const DECIMAL_UNITS = { 0: 'unit', 1: 'ten', 2: 'hundred', 3: 'thousand', 6: 'million', 9: 'billion', 12: 'trillion', 15: 'quadrillion', '-1': 'deci', '-2': 'centi', '-3': 'mili', '-6': 'micro', '-9': 'nano', '-12': 'pico', '-15': 'femto' };

function exponentOf(d) {
  if (d.int !== '0') return d.int.length - 1;
  const lead = d.frac.match(/^0*/)[0].length;
  return lead === d.frac.length ? 0 : -(lead + 1);
}

/** number_to_human(1234567) # => "1.23 Million" */
export function numberToHuman(number, options = {}) {
  const o = optionsFor('human', options);
  const units = { ...NUMBER_DEFAULTS.human.units, ...(lookup(options, 'number.human.decimal_units.units') ?? {}), ...(typeof o.units === 'object' ? o.units : {}) };
  const format = o.format && o.format.includes('%u') ? o.format : lookup(options, 'number.human.decimal_units.format') ?? '%n %u';
  const d = parseDecimal(number);
  // Round first (Rails rounds, then takes the exponent of the rounded number).
  const rounded = parseDecimal(formatRounded(d, { ...o, delimiter: '', separator: '.', strip_insignificant_zeros: false }));
  const exponent = exponentOf(rounded);
  const available = Object.entries(DECIMAL_UNITS)
    .filter(([, name]) => units[name] !== undefined)
    .map(([e]) => Number(e))
    .sort((a, b) => b - a);
  const unitExp = available.find((e) => e <= exponent) ?? available[available.length - 1] ?? 0;
  const scaled = shift(d, -unitExp);
  const value = formatRounded(scaled, o);
  const unit = units[DECIMAL_UNITS[unitExp]];
  const unitText = typeof unit === 'object' ? (Number(value.replace(o.separator, '.')) === 1 ? unit.one : unit.other) : unit;
  return format.replace('%n', value).replace('%u', unitText ?? '').trim();
}

function shift(d, places) {
  const digits = d.int + d.frac;
  const point = d.int.length + places;
  const padded = point < 0 ? '0'.repeat(-point) + digits : point > digits.length ? digits + '0'.repeat(point - digits.length) : digits;
  const p = Math.max(point, 0);
  return parseDecimal(`${d.neg ? '-' : ''}${padded.slice(0, p) || '0'}.${padded.slice(p)}`);
}

const STORAGE = ['byte', 'kb', 'mb', 'gb', 'tb', 'pb', 'eb', 'zb'];

/** number_to_human_size(1234567) # => "1.18 MB" */
export function numberToHumanSize(number, options = {}) {
  const o = optionsFor('human', options);
  const units = { ...NUMBER_DEFAULTS.storage_units.units, ...(lookup(options, 'number.human.storage_units.units') ?? {}) };
  const format = lookup(options, 'number.human.storage_units.format') ?? NUMBER_DEFAULTS.storage_units.format;
  const n = Number(parseDecimal(number).int + '.' + (parseDecimal(number).frac || '0'));
  let exponent = 0;
  while (exponent < STORAGE.length - 1 && n >= 1024 ** (exponent + 1)) exponent += 1;
  if (exponent === 0) {
    const unit = units.byte;
    const count = Math.trunc(n);
    const unitText = typeof unit === 'object' ? (count === 1 ? unit.one : unit.other) : unit;
    return format.replace('%n', String(count)).replace('%u', unitText);
  }
  const value = formatRounded(String(n / 1024 ** exponent), o);
  return format.replace('%n', value).replace('%u', units[STORAGE[exponent]]);
}

/** number_to_phone(5551234) # => "555-1234" */
export function numberToPhone(number, options = {}) {
  const o = snake(options);
  const delimiter = o.delimiter ?? '-';
  let s = String(number).trim();
  if (o.area_code) {
    s = s.replace(o.pattern ?? /(\d{1,3})(\d{3})(\d{4}$)/, `($1) $2${delimiter}$3`);
  } else {
    s = s.replace(o.pattern ?? /(\d{0,3})(\d{3})(\d{4})$/, `$1${delimiter}$2${delimiter}$3`);
    if (delimiter && s.startsWith(delimiter)) s = s.slice(delimiter.length);
  }
  let out = '';
  if (o.country_code !== undefined && o.country_code !== null && o.country_code !== '') out += `+${o.country_code}${delimiter}`;
  out += s;
  if (o.extension !== undefined && o.extension !== null && o.extension !== '') out += ` x ${o.extension}`;
  return out;
}
