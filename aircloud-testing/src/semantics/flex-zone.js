// @aircloudhq/testing — the product time zone (ADR-259 decision 1), as flex/src/zone.rs reads it: the
// rules a compiled locale bundle carries (contracts/deploy/v1/locale-bundle-v1.json `$defs.zone`, RFC
// 8536's model), received by PUT /v1/schema as `time_zone` + `time_zone_rules` (plan decision R35) —
// never the host's time-zone database. contracts/flex/v1/default-vectors.json `today_vectors` pins it.
import { validation } from "./flex-values.js";

export const ZONE_NAME_RE = /^[A-Za-z0-9_+./-]+$/;
const RULE_TIME_MAX = 167 * 3600;

function invalid(msg) {
  return validation(`time_zone_rules: ${msg}`, "time_zone_rules");
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function closed(v, keys, at) {
  if (!isObj(v)) throw invalid(`${at} must be an object`);
  for (const k of keys) if (!(k in v)) throw invalid(`${at} requires '${k}'`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw invalid(`unknown key '${k}' in ${at}`);
}
function localTime(v, at) {
  closed(v, ["offset", "dst", "abbr"], at);
  if (!Number.isInteger(v.offset) || typeof v.dst !== "boolean" || typeof v.abbr !== "string") throw invalid(`${at} is malformed`);
  if (v.abbr === "") throw invalid("an abbreviation is empty");
}
function ruleDate(v, at) {
  closed(v, ["kind", "month", "week", "weekday", "time"], at);
  const ok = v.kind === "m" && Number.isInteger(v.month) && v.month >= 1 && v.month <= 12
    && Number.isInteger(v.week) && v.week >= 1 && v.week <= 5
    && Number.isInteger(v.weekday) && v.weekday >= 0 && v.weekday <= 6
    && Number.isInteger(v.time) && Math.abs(v.time) <= RULE_TIME_MAX;
  if (!ok) throw invalid("a rule date is not a POSIX Mm.w.d date");
}

/** Judge a zone's rules exactly as flex/src/zone.rs Zone::parse does; returns them. */
export function parseZone(v) {
  closed(v, ["initial", "transitions", "rule"], "the zone");
  localTime(v.initial, "initial");
  if (!Array.isArray(v.transitions)) throw invalid("transitions must be an array");
  v.transitions.forEach((t, i) => {
    closed(t, ["at", "offset", "dst", "abbr"], "a transition");
    if (!Number.isInteger(t.at)) throw invalid("a transition's instant must be an integer");
    localTime({ offset: t.offset, dst: t.dst, abbr: t.abbr }, "a transition");
    if (i > 0 && v.transitions[i - 1].at >= t.at) throw invalid("transitions must be in strictly ascending order");
  });
  if (v.rule !== null) {
    closed(v.rule, ["std", "dst", "start", "end"], "the rule");
    localTime(v.rule.std, "rule.std");
    if (v.rule.dst !== null) localTime(v.rule.dst, "rule.dst");
    for (const d of ["start", "end"]) if (v.rule[d] !== null) ruleDate(v.rule[d], `rule.${d}`);
    if (v.rule.dst !== null && (v.rule.start === null || v.rule.end === null)) throw invalid("a daylight rule needs its start and end dates");
  }
  return v;
}

const DAY = 86400;
const floorDiv = (a, b) => Math.floor(a / b);
function daysFromCivil(y, m, d) {
  return floorDiv(Date.UTC(y, m - 1, d), DAY * 1000);
}
function civilYear(days) {
  return new Date(days * DAY * 1000).getUTCFullYear();
}
// The local wall-clock second (as if local time were UTC) of an Mm.w.d date in `year`.
function wallSecond(year, d) {
  const first = daysFromCivil(year, d.month, 1);
  const weekday = new Date(first * DAY * 1000).getUTCDay();
  let day = first + ((d.weekday - weekday + 7) % 7) + (d.week - 1) * 7;
  const next = d.month === 12 ? daysFromCivil(year + 1, 1, 1) : daysFromCivil(year, d.month + 1, 1);
  while (day >= next) day -= 7;
  return day * DAY + d.time;
}
function ruleOffset(rule, at) {
  if (!rule.dst) return rule.std.offset;
  const year = civilYear(floorDiv(at + rule.std.offset, DAY));
  const s = wallSecond(year, rule.start) - rule.std.offset;
  const e = wallSecond(year, rule.end) - rule.dst.offset;
  const inDst = s < e ? at >= s && at < e : !(at >= e && at < s);
  return inDst ? rule.dst.offset : rule.std.offset;
}

/** The UTC offset (seconds east) in force at Unix second `at`. */
export function offsetAt(zone, at) {
  const ts = zone.transitions;
  if (ts.length === 0) return zone.rule ? ruleOffset(zone.rule, at) : zone.initial.offset;
  if (at < ts[0].at) return zone.initial.offset;
  let lo = 0;
  let hi = ts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid].at <= at) lo = mid;
    else hi = mid - 1;
  }
  if (lo === ts.length - 1 && zone.rule) return ruleOffset(zone.rule, at);
  return ts[lo].offset;
}

/** The `YYYY-MM-DD` date of Unix second `at` in `zone`. */
export function dateAt(zone, at) {
  return new Date((at + offsetAt(zone, at)) * 1000).toISOString().slice(0, 10);
}
