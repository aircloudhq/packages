// Exact decimal arithmetic on the digits of a number, so rounding is Ruby BigDecimal's half-up and
// never a binary float's (ADR-223 D6: the JavaScript and Rust runtimes agree digit for digit).
//
// A decimal is { neg, int, frac } where int and frac are digit strings (int without leading zeros,
// "0" for zero).

/** Parse a number or a decimal string (optionally signed, optionally with an exponent). */
export function parseDecimal(value) {
  let s;
  if (value && typeof value === 'object' && typeof value.int === 'string' && typeof value.frac === 'string') {
    return { neg: Boolean(value.neg), int: value.int, frac: value.frac };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
    s = String(value); // the shortest round-trip representation
  } else if (typeof value === 'bigint') {
    s = value.toString();
  } else if (typeof value === 'string') {
    s = value.trim();
  } else {
    throw new TypeError(`not a number: ${value}`);
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new RangeError(`not a decimal: ${JSON.stringify(value)}`);
  let int = m[2] || '0';
  let frac = m[3] ?? '';
  const exp = m[4] ? Number(m[4]) : 0;
  if (exp > 0) {
    const shift = frac.padEnd(exp, '0');
    int += shift.slice(0, exp);
    frac = shift.slice(exp);
  } else if (exp < 0) {
    const pad = int.padStart(-exp + 1, '0');
    frac = pad.slice(pad.length + exp) + frac;
    int = pad.slice(0, pad.length + exp);
  }
  int = int.replace(/^0+(?=\d)/, '');
  const zero = /^0*$/.test(int) && /^0*$/.test(frac);
  return { neg: m[1] === '-' && !zero, int, frac };
}

/** Round half-up (away from zero on a tie) to `precision` fraction digits; pads with zeros. */
export function roundFixed(d, precision) {
  if (precision < 0) throw new RangeError('negative precision');
  if (d.frac.length <= precision) return { ...d, frac: d.frac.padEnd(precision, '0') };
  const keep = d.int + d.frac.slice(0, precision);
  const up = d.frac.charCodeAt(precision) >= 53; // '5'
  let digits = up ? increment(keep) : keep;
  const intLen = digits.length - precision;
  const int = digits.slice(0, intLen).replace(/^0+(?=\d)/, '') || '0';
  const frac = digits.slice(intLen);
  const zero = /^0*$/.test(int) && /^0*$/.test(frac);
  return { neg: d.neg && !zero, int, frac };
}

/** Round half-up to `digits` significant digits (Rails `significant: true`). */
export function roundSignificant(d, digits) {
  const all = (d.int + d.frac).replace(/^0+/, '');
  if (all === '') return { ...d, frac: '' };
  const intDigits = d.int === '0' ? 0 : d.int.length;
  // position of the first significant digit relative to the decimal point
  const leadingFracZeros = d.int === '0' ? d.frac.match(/^0*/)[0].length : 0;
  const precision = intDigits > 0 ? Math.max(digits - intDigits, 0) : digits + leadingFracZeros;
  if (intDigits > digits) {
    // round the integer part itself
    const scaled = { neg: d.neg, int: d.int.slice(0, digits), frac: d.int.slice(digits) + d.frac };
    const r = roundFixed(scaled, 0);
    return { neg: r.neg, int: r.int + '0'.repeat(intDigits - digits), frac: '' };
  }
  return roundFixed(d, precision);
}

function increment(digits) {
  const a = digits.split('');
  let i = a.length - 1;
  while (i >= 0) {
    if (a[i] === '9') {
      a[i] = '0';
      i -= 1;
    } else {
      a[i] = String.fromCharCode(a[i].charCodeAt(0) + 1);
      return a.join('');
    }
  }
  return '1' + a.join('');
}

/** Group the integer digits with `delimiter` every three digits. */
export function delimit(int, delimiter) {
  if (!delimiter) return int;
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, delimiter);
}

/** Compare a decimal to an integer. */
export function isInteger(d) {
  return /^0*$/.test(d.frac);
}

export function toNumber(d) {
  return Number(`${d.neg ? '-' : ''}${d.int}${d.frac ? '.' + d.frac : ''}`);
}

export function abs(d) {
  return { ...d, neg: false };
}

export function toPlain(d) {
  return `${d.neg ? '-' : ''}${d.int}${d.frac ? '.' + d.frac : ''}`;
}
