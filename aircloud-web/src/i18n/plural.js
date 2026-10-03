// CLDR plural categories (UTS #35 Part 3) evaluated over the bundle's rule AST — never Intl.PluralRules.
import { parseDecimal } from './decimal.js';

/** The UTS #35 operands of a count (a number or a decimal string; visible fraction digits count). */
export function operands(count) {
  const d = parseDecimal(count);
  const frac = d.frac;
  const trimmed = frac.replace(/0+$/, '');
  const i = Number(d.int);
  return {
    n: Number(`${d.int}${frac ? '.' + frac : ''}`),
    i,
    v: frac.length,
    w: trimmed.length,
    f: frac ? Number(frac) : 0,
    t: trimmed ? Number(trimmed) : 0,
    e: 0,
  };
}

function relationMatches(rel, ops) {
  let value = ops[rel.operand];
  if (rel.mod) value = rel.operand === 'n' ? value % rel.mod : value % rel.mod;
  // n (and n % m) matches a range only when integral (UTS #35: ranges are integer ranges).
  const integral = rel.operand !== 'n' || (ops.t === 0 && Number.isInteger(value));
  const inRange = integral && rel.ranges.some(([lo, hi]) => value >= lo && value <= hi);
  return rel.negated ? !inRange : inRange;
}

function ruleMatches(rule, ops) {
  return rule.or.some((and) => and.every((rel) => relationMatches(rel, ops)));
}

/** The CLDR category of `count` under a locale's ordered categories (the last is `other`). */
export function pluralCategory(categories, count) {
  const ops = operands(count);
  for (const { category, rule } of categories) {
    if (category !== 'other' && ruleMatches(rule, ops)) return category;
  }
  return 'other';
}
