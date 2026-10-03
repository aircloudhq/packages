// Time-zone rendering from the bundle's zone rules (RFC 8536's model; contracts/deploy/v1/
// locale-bundle-v1.json `zone`) — never the host's time-zone database.
import { civilFromDays, daysFromCivil, floorDiv } from './civil.js';

/** The local time type ({offset, dst, abbr}) of `zone` at Unix second `at`. */
export function zoneAt(zone, at) {
  const ts = zone.transitions;
  if (ts.length === 0) return zone.rule ? ruleAt(zone.rule, at) : zone.initial;
  if (at < ts[0].at) return zone.initial;
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid].at <= at) lo = mid;
    else hi = mid - 1;
  }
  if (lo === ts.length - 1 && zone.rule) return ruleAt(zone.rule, at);
  const { offset, dst, abbr } = ts[lo];
  return { offset, dst, abbr };
}

function ruleAt(rule, at) {
  if (!rule.dst) return rule.std;
  const [year] = civilFromDays(floorDiv(at + rule.std.offset, 86400));
  const start = wallSecond(year, rule.start) - rule.std.offset;
  const end = wallSecond(year, rule.end) - rule.dst.offset;
  const inDst = start < end ? at >= start && at < end : !(at >= end && at < start);
  return inDst ? rule.dst : rule.std;
}

// The local wall-clock second (seconds since the epoch, as if local time were UTC) of an Mm.w.d date.
function wallSecond(year, d) {
  const first = daysFromCivil(year, d.month, 1);
  const weekday = (((first % 7) + 7 + 4) % 7); // 1970-01-01 was a Thursday
  let day = first + ((d.weekday - weekday + 7) % 7) + (d.week - 1) * 7;
  const next = d.month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, d.month + 1, 1);
  while (day >= next) day -= 7;
  return day * 86400 + d.time;
}
