// ActionView::Helpers::DateHelper — the distance-in-words helpers, over the locale's
// `datetime.distance_in_words.*` keys (pluralized by count). Instants only: the arithmetic uses
// epoch milliseconds and UTC calendar fields, never the host's time zone.
import { requireI18n } from '../i18n/current.js';

const MINUTES_IN_YEAR = 525600;
const MINUTES_IN_QUARTER_YEAR = 131400;
const MINUTES_IN_THREE_QUARTERS_YEAR = 394200;

const ms = (t) => (t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t));
const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

/** distance_of_time_in_words(from_time, from_time + 50.minutes) # => "about 1 hour" */
export function distanceOfTimeInWords(fromTime, toTime = 0, options = {}) {
  const i18n = requireI18n(options, 'distanceOfTimeInWords');
  const scope = options.scope ?? 'datetime.distance_in_words';
  let from = ms(fromTime);
  let to = ms(toTime);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new RangeError('distanceOfTimeInWords: not a time');
  if (from > to) [from, to] = [to, from];
  const tr = (key, count) => i18n.t(key, { scope, count });
  const seconds = Math.round((to - from) / 1000);
  const minutes = Math.round((to - from) / 60000);
  if (minutes <= 1) {
    if (!options.includeSeconds && !options.include_seconds) {
      return minutes === 0 ? tr('less_than_x_minutes', 1) : tr('x_minutes', minutes);
    }
    if (seconds <= 4) return tr('less_than_x_seconds', 5);
    if (seconds <= 9) return tr('less_than_x_seconds', 10);
    if (seconds <= 19) return tr('less_than_x_seconds', 20);
    if (seconds <= 39) return tr('half_a_minute');
    if (seconds <= 59) return tr('less_than_x_minutes', 1);
    return tr('x_minutes', 1);
  }
  if (minutes < 45) return tr('x_minutes', minutes);
  if (minutes < 90) return tr('about_x_hours', 1);
  if (minutes < 1440) return tr('about_x_hours', Math.round(minutes / 60));
  if (minutes < 2520) return tr('x_days', 1);
  if (minutes < 43200) return tr('x_days', Math.round(minutes / 1440));
  if (minutes < 86400) return tr('about_x_months', Math.round(minutes / 43200));
  if (minutes < 525600) return tr('x_months', Math.round(minutes / 43200));
  const f = new Date(from);
  const t = new Date(to);
  let fromYear = f.getUTCFullYear();
  if (f.getUTCMonth() + 1 >= 3) fromYear += 1;
  let toYear = t.getUTCFullYear();
  if (t.getUTCMonth() + 1 < 3) toYear -= 1;
  let leapYears = 0;
  for (let y = fromYear; y <= toYear; y += 1) if (isLeap(y)) leapYears += 1;
  const withOffset = minutes - leapYears * 1440;
  const remainder = withOffset % MINUTES_IN_YEAR;
  const years = Math.floor(withOffset / MINUTES_IN_YEAR);
  if (remainder < MINUTES_IN_QUARTER_YEAR) return tr('about_x_years', years);
  if (remainder < MINUTES_IN_THREE_QUARTERS_YEAR) return tr('over_x_years', years);
  return tr('almost_x_years', years + 1);
}

/** time_ago_in_words(3.minutes.from_now) # => "3 minutes" */
export function timeAgoInWords(fromTime, options = {}) {
  return distanceOfTimeInWords(fromTime, options.now ?? Date.now(), options);
}

/** distance_of_time_in_words_to_now — Rails' alias of time_ago_in_words. */
export function distanceOfTimeInWordsToNow(fromTime, options = {}) {
  return timeAgoInWords(fromTime, options);
}
