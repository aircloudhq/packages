// The strftime subset of spec S4 § Constants, as Rails' I18n `l` renders it: the name directives
// (%a %A %b %B %p %P) come from the locale data, everything else is Ruby's strftime.
import { dayOfYear } from './civil.js';

const pad = (n, w, c = '0') => String(n).padStart(w, c);

/**
 * Format a broken-down local time.
 * @param {string} format
 * @param {{year,month,day,hour,minute,second,wday,offset:number|null,abbr:string|null}} t
 *   offset/abbr null for a civil date (Ruby Date renders %Z as +00:00 and %z as +0000).
 * @param {(kind: 'day_names'|'abbr_day_names'|'month_names'|'abbr_month_names'|'am'|'pm') => any} names
 */
export function strftime(format, t, names) {
  let out = '';
  for (let i = 0; i < format.length; i += 1) {
    const c = format[i];
    if (c !== '%' || i === format.length - 1) {
      out += c;
      continue;
    }
    let spec = format[i + 1];
    let flag = '';
    if (spec === '-' && i + 2 < format.length) {
      flag = '-';
      spec = format[i + 2];
    }
    const r = directive(flag, spec, t, names);
    if (r === null) {
      out += c; // an unsupported directive is emitted as written (Ruby)
      continue;
    }
    out += r;
    i += flag ? 2 : 1;
  }
  return out;
}

function directive(flag, spec, t, names) {
  const hour12 = t.hour % 12 === 0 ? 12 : t.hour % 12;
  if (flag === '-') {
    switch (spec) {
      case 'm': return String(t.month);
      case 'd': return String(t.day);
      case 'H': return String(t.hour);
      case 'I': return String(hour12);
      default: return null;
    }
  }
  switch (spec) {
    case 'Y': return String(t.year);
    case 'y': return pad(((t.year % 100) + 100) % 100, 2);
    case 'm': return pad(t.month, 2);
    case 'd': return pad(t.day, 2);
    case 'e': return pad(t.day, 2, ' ');
    case 'H': return pad(t.hour, 2);
    case 'I': return pad(hour12, 2);
    case 'M': return pad(t.minute, 2);
    case 'S': return pad(t.second, 2);
    case 'j': return pad(dayOfYear(t.year, t.month, t.day), 3);
    case 'p': return String(names(t.hour < 12 ? 'am' : 'pm')).toUpperCase();
    case 'P': return String(names(t.hour < 12 ? 'am' : 'pm')).toLowerCase();
    case 'A': return names('day_names')[t.wday];
    case 'a': return names('abbr_day_names')[t.wday];
    case 'B': return names('month_names')[t.month];
    case 'b': return names('abbr_month_names')[t.month];
    case 'Z': return t.offset === null ? '+00:00' : t.abbr;
    case 'z': {
      const o = t.offset ?? 0;
      const a = Math.abs(o);
      return `${o < 0 ? '-' : '+'}${pad(Math.floor(a / 3600), 2)}${pad(Math.floor((a % 3600) / 60), 2)}`;
    }
    case '%': return '%';
    default: return null;
  }
}
