// Proleptic Gregorian civil-date arithmetic in whole days since 1970-01-01 (H. Hinnant's
// days_from_civil / civil_from_days) — independent of the host's Date time-zone behaviour.

export function floorDiv(a, b) {
  return Math.floor(a / b);
}

export function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = floorDiv(yy, 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days) {
  const z = days + 719468;
  const era = floorDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

export function isLeap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

/** 1-based day of the year. */
export function dayOfYear(y, m, d) {
  return daysFromCivil(y, m, d) - daysFromCivil(y, 1, 1) + 1;
}

/** 0 = Sunday. */
export function weekdayOf(days) {
  return (((days % 7) + 7 + 4) % 7);
}
