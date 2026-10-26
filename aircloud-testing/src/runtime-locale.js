// The functions runtime's locale and time-zone behaviour, installed over Node's for the duration of an
// invocation (Mock fidelity, docs/conventions/code-quality.md).
//
// MEASURED, NOT CHOSEN. #768 I15 built a guest with the builder's own toolchain (componentize-js 0.21.0
// / jco 1.24.6 / StarlingMonkey, the platform prelude) and ran it through functions-host's
// WasmExecutor; docs/plans/768-release-verification-root-causes.plan.json `claims` carries every command
// and its verbatim output. StarlingMonkey is built without Intl, so there:
//
//   * `Intl` does not exist — `new Intl.DateTimeFormat(…)` is `ReferenceError: Intl is not defined`;
//   * local time is UTC — `getTimezoneOffset()` is 0, `getHours()` is the UTC hour, and `toString()`
//     ends `GMT+0000 (UTC)`;
//   * `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` ignore their locale and options
//     (a `timeZone` too) and render fixed UTC shapes: `Thu Jan  1 00:00:00 1970`, `01/01/1970`,
//     `00:00:00`; an invalid date is `InvalidDate`;
//   * `Number#toLocaleString` and `BigInt#toLocaleString` are their `toString`.
//
// Node has full ICU, so without this a function that formats through Intl passes its unit tests and
// fails on the platform. Only these measured entry points are replaced; a time zone in a function comes
// from the release bundle (@aircloudhq/web/function civilDate / instantOf, ADR-223 D4).
//
// Local time is moved by `process.env.TZ`, which Node applies to Date at once — the one lever that
// moves every local-time Date method together, rather than a re-implementation of each.
//
// Invocations run concurrently, so the runtime is installed when the first one starts and Node's
// behaviour is restored when the last one settles. Other code running in the same process meanwhile
// sees the runtime's behaviour too.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const INVALID = "InvalidDate";
const two = (n) => String(n).padStart(2, "0");

// `this` is a Date (getTime throws the TypeError Node's methods throw otherwise); NaN is an invalid one.
const timeOf = (d) => Date.prototype.getTime.call(d);
const clock = (d) => `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;

function toLocaleString() {
  if (Number.isNaN(timeOf(this))) return INVALID;
  const day = String(this.getUTCDate()).padStart(2, " ");
  return `${DAYS[this.getUTCDay()]} ${MONTHS[this.getUTCMonth()]} ${day} ${clock(this)} ${this.getUTCFullYear()}`;
}

function toLocaleDateString() {
  if (Number.isNaN(timeOf(this))) return INVALID;
  return `${two(this.getUTCMonth() + 1)}/${two(this.getUTCDate())}/${this.getUTCFullYear()}`;
}

function toLocaleTimeString() {
  if (Number.isNaN(timeOf(this))) return INVALID;
  return clock(this);
}

/** The methods replaced while installed: [owner, name, runtime implementation given Node's]. */
const METHODS = [
  [Date.prototype, "toLocaleString", () => toLocaleString],
  [Date.prototype, "toLocaleDateString", () => toLocaleDateString],
  [Date.prototype, "toLocaleTimeString", () => toLocaleTimeString],
  // Node under TZ=UTC names the zone "(Coordinated Universal Time)"; the runtime names it "(UTC)".
  [Date.prototype, "toString", (node) => function toString() {
    return node.call(this).replace(/ \([^)]*\)$/, " (UTC)");
  }],
  [Number.prototype, "toLocaleString", () => function toLocaleString() { return Number.prototype.toString.call(this); }],
  [BigInt.prototype, "toLocaleString", () => function toLocaleString() { return BigInt.prototype.toString.call(this); }],
];

let active = 0;
let saved = null;

function install() {
  const methods = METHODS.map(([owner, name, runtime]) => {
    const node = Object.getOwnPropertyDescriptor(owner, name);
    Object.defineProperty(owner, name, { ...node, value: runtime(node.value) });
    return [owner, name, node];
  });
  saved = {
    intl: Object.getOwnPropertyDescriptor(globalThis, "Intl"),
    hadTz: Object.prototype.hasOwnProperty.call(process.env, "TZ"),
    tz: process.env.TZ,
    methods,
  };
  delete globalThis.Intl;
  process.env.TZ = "UTC";
}

function restore() {
  for (const [owner, name, node] of saved.methods) Object.defineProperty(owner, name, node);
  if (saved.intl) Object.defineProperty(globalThis, "Intl", saved.intl);
  if (saved.hadTz) process.env.TZ = saved.tz;
  else delete process.env.TZ;
  saved = null;
}

/** Run `fn` (sync or async) with the functions runtime's locale and time-zone behaviour in place. */
export async function withRuntimeLocale(fn) {
  if (active++ === 0) install();
  try {
    return await fn();
  } finally {
    if (--active === 0) restore();
  }
}
