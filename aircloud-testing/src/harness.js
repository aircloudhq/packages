// @aircloudhq/testing — invoke a JavaScript function the way the platform does.
//
// A JS guest is a StarlingMonkey program: at top level it registers `addEventListener("fetch", …)`
// and the listener answers with `event.respondWith(response)`. The functions host instantiates the
// component FRESH for every invocation, so module-level state never survives from one invocation to
// the next. `invoke` reproduces both: it evaluates the guest program anew per call (the entry URL is
// marked, and hooks.js carries the mark to every relatively-imported module and loads them as ESM),
// with an `addEventListener` global in place while it evaluates, then dispatches one FetchEvent.
// It therefore needs the hooks: run under `node --import @aircloudhq/testing/register`.
//
// The platform's JS guest prelude (functions/builders/js-platform-prelude.js, copied verbatim into
// generated/platform-prelude.js) is prepended to every guest the platform builds; importing this
// package evaluates the same prelude, so a function's BigInt serialization behaves as it will live.
//
// THE CORRELATION ID. Each invocation resolves one correlation id as the host's entry surface does
// (src/correlation.js, contracts/functions/v1/correlation-v1.json): the caller's x-correlation-id when
// it is a UUID, else a minted one. The guest's request carries it under that header, replacing the
// caller's value, and every capability call the invocation makes carries it on `world.calls` and on a
// refusal's envelope.
import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import "../generated/platform-prelude.js";
import { CORRELATION_HEADER, resolveCorrelationId, withInvocation } from "./correlation.js";
import { DoubleMisuseError } from "./errors.js";

let invocation = 0;

// Guest programs are evaluated one at a time: the `addEventListener` global is the one channel a
// program registers through, so two evaluations sharing it would hand one invocation the other's
// listener. Only evaluation is serialized; the dispatched invocations then run concurrently, each a
// fresh instance, as the host runs them.
let evaluating = Promise.resolve();

async function evaluate(url) {
  const before = evaluating;
  let release;
  evaluating = new Promise((r) => { release = r; });
  await before;
  const listeners = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    writable: true,
    value: (type, fn) => { if (type === "fetch") listeners.push(fn); },
  });
  try {
    await import(url.href);
  } finally {
    if (saved) Object.defineProperty(globalThis, "addEventListener", saved);
    else delete globalThis.addEventListener;
    release();
  }
  return listeners;
}

/**
 * Invoke the function whose entry module is `entry` (a path or file URL) with `request`
 * (a Request, or a URL string). Resolves to the guest's Response.
 */
export async function invoke(entry, request) {
  const sent = typeof request === "string" ? new Request(request) : request;
  if (!(sent instanceof Request)) throw new DoubleMisuseError("invoke(entry, request): request must be a Request or a URL");
  const correlationId = resolveCorrelationId(sent.headers.get(CORRELATION_HEADER));
  const headers = new Headers(sent.headers);
  headers.set(CORRELATION_HEADER, correlationId);
  const req = new Request(sent, { headers });
  return withInvocation(correlationId, () => dispatch(entry, req));
}

async function dispatch(entry, req) {
  const url = entry instanceof URL ? new URL(entry.href) : pathToFileURL(isAbsolute(entry) ? entry : resolve(process.cwd(), entry));
  url.searchParams.set("air-invocation", String(++invocation));

  const listeners = await evaluate(url);
  if (listeners.length === 0) throw new DoubleMisuseError(`${entry} registers no fetch listener`);

  let responded = null;
  const event = {
    type: "fetch",
    request: req,
    respondWith(r) {
      if (responded) throw new Error("respondWith called twice");
      responded = Promise.resolve(r);
    },
    waitUntil() {},
  };
  // The first listener that responds wins, as in the Service Worker dispatch StarlingMonkey follows.
  for (const fn of listeners) {
    fn(event);
    if (responded) break;
  }
  if (!responded) {
    // The platform answers this as functions.guest_no_response (contracts/functions/v1/errors.json).
    throw new Error("the guest's fetch listener returned without calling event.respondWith() — functions.guest_no_response on the platform");
  }
  const res = await responded;
  if (!(res instanceof Response)) throw new Error("the guest responded with something that is not a Response");
  return res;
}
