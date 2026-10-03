// ActionView::Helpers::TextHelper at the census commit. `simpleFormat` and `highlight` return markup
// (sanitized first, as in Rails); the others return plain text.
import { i18nFor } from '../i18n/current.js';
import { escapeHtml } from '../i18n/index.js';
import { sanitize } from './sanitize.js';

/** pluralize(2, "person") # => "2 people" — the locale's inflections (ADR-223). */
export function pluralize(count, singular, plural, options = {}) {
  const opts = typeof plural === 'object' && plural !== null ? plural : options;
  const explicit = typeof plural === 'string' ? plural : opts.plural;
  const i = i18nFor(opts);
  if (i) return i.pluralize(count, singular, explicit);
  const one = count === 1 || /^1(\.0+)?$/.test(String(count));
  return `${count ?? 0} ${one ? singular : explicit ?? singular}`;
}

/** truncate("Once upon a time in a world far far away") # => "Once upon a time in a world..." */
export function truncate(text, options = {}) {
  const s = String(text ?? '');
  const length = options.length ?? 30;
  const omission = options.omission ?? '...';
  if ([...s].length <= length) return s;
  const chars = [...s];
  let stop = length - [...omission].length;
  if (stop < 0) stop = 0;
  if (options.separator !== undefined && options.separator !== null) {
    const head = chars.slice(0, stop + 1).join('');
    const sep = options.separator;
    let at = -1;
    if (sep instanceof RegExp) {
      const re = new RegExp(sep.source, sep.flags.includes('g') ? sep.flags : sep.flags + 'g');
      for (const m of head.matchAll(re)) if (m.index <= stop) at = m.index;
    } else {
      at = head.lastIndexOf(sep, stop);
    }
    if (at >= 0) stop = [...head.slice(0, at)].length;
  }
  return chars.slice(0, stop).join('') + omission;
}

/** simple_format("Here is some basic text...\n...with a line break.") # => "<p>Here is some basic text...\n<br />...with a line break.</p>" */
export function simpleFormat(text, htmlOptions = {}, options = {}) {
  const wrapper = options.wrapperTag ?? options.wrapper_tag ?? 'p';
  const s = options.sanitize === false ? String(text ?? '') : sanitize(String(text ?? ''), options.sanitizeOptions ?? {});
  const attrs = Object.entries(htmlOptions)
    .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
    .join('');
  const paragraphs = s.replace(/\r\n?/g, '\n').split(/\n\n+/).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return `<${wrapper}${attrs}></${wrapper}>`;
  return paragraphs
    .map((p) => `<${wrapper}${attrs}>${p.replace(/([^\n]\n)(?=[^\n])/g, '$1<br />')}</${wrapper}>`)
    .join('\n\n');
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** highlight("You searched for: rails", "rails") # => "You searched for: <mark>rails</mark>" */
export function highlight(text, phrases, options = {}) {
  const s = options.sanitize === false ? String(text ?? '') : sanitize(String(text ?? ''));
  const list = (Array.isArray(phrases) ? phrases : [phrases]).filter((p) => p !== null && p !== undefined && String(p) !== '');
  if (!s || list.length === 0) return s;
  const highlighter = options.highlighter ?? '<mark>\\1</mark>';
  const match = list.map((p) => (p instanceof RegExp ? p.source : escapeRegExp(p))).join('|');
  return s.replace(new RegExp(`(${match})(?![^<]*?>)`, 'gi'), (_, m) => highlighter.replace(/\\1/g, m));
}

function cutExcerptPart(position, part, separator, options) {
  if (part === undefined) return ['', ''];
  const radius = options.radius ?? 100;
  const omission = options.omission ?? '...';
  let pieces = separator === '' ? [...part] : part.split(separator);
  pieces = pieces.filter((p) => p !== '');
  const affix = pieces.length > radius ? omission : '';
  pieces = position === 'first' ? pieces.slice(Math.max(pieces.length - radius, 0)) : pieces.slice(0, radius);
  return [affix, pieces.join(separator)];
}

/** excerpt("This is an example", "an", radius: 5) # => "...s is an exam..." */
export function excerpt(text, phrase, options = {}) {
  if (text === null || text === undefined || phrase === null || phrase === undefined) return undefined;
  const separator = options.separator ?? '';
  const regex = phrase instanceof RegExp ? phrase : new RegExp(escapeRegExp(phrase), 'i');
  const matched = String(text).match(regex);
  if (!matched) return undefined;
  let found = matched[0];
  if (separator !== '') {
    const hit = String(text).split(separator).find((v) => regex.test(v));
    if (hit !== undefined) found = hit;
  }
  const idx = String(text).indexOf(found);
  const first = String(text).slice(0, idx);
  const second = String(text).slice(idx + found.length);
  const [prefix, firstPart] = cutExcerptPart('first', first, separator, options);
  const [postfix, secondPart] = cutExcerptPart('second', second, separator, options);
  const affix = [firstPart, separator, found, separator, secondPart].join('').trim();
  return [prefix, affix, postfix].join('');
}

/** word_wrap("Once upon a time", line_width: 8) # => "Once\nupon a\ntime" */
export function wordWrap(text, options = {}) {
  const width = options.lineWidth ?? options.line_width ?? 80;
  const brk = options.breakSequence ?? options.break_sequence ?? '\n';
  return String(text ?? '')
    .split('\n')
    .map((line) =>
      line.length > width
        ? line.replace(new RegExp(`(.{1,${width}})(\\s+|$)`, 'g'), `$1${brk}`).replace(/\s+$/, '')
        : line,
    )
    .join(brk);
}

const cycles = new Map();

/** cycle("odd", "even") — alternates between its values on each call (one cycle per `name`). */
export function cycle(...values) {
  let name = 'default';
  const last = values[values.length - 1];
  if (last && typeof last === 'object' && !Array.isArray(last)) {
    name = last.name ?? name;
    values = values.slice(0, -1);
  }
  const key = JSON.stringify(values);
  let c = cycles.get(name);
  if (!c || c.key !== key) {
    c = { key, values, index: 0 };
    cycles.set(name, c);
  }
  const v = c.values[c.index];
  c.index = (c.index + 1) % c.values.length;
  return v;
}

/** reset_cycle(name) */
export function resetCycle(name = 'default') {
  cycles.delete(name);
}

/** current_cycle(name) */
export function currentCycle(name = 'default') {
  const c = cycles.get(name);
  return c ? c.values[(c.index + c.values.length - 1) % c.values.length] : undefined;
}
