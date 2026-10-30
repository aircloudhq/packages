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
// THE LOCALE AND TIME ZONE. For the duration of an invocation the guest sees the functions runtime's
// Intl and time-zone behaviour, measured in functions-host (#768 I15), not Node's: no Intl, local time
// UTC, the Date locale methods' fixed shapes (src/runtime-locale.js).
//
// THE ENTRY (#384 D66). A function runs only through an entry its release declares — a [[route]], an event
// or cron trigger, a direct invoke — and acts at the node the functions-host resolves for that entry before
// it runs (src/semantics/entries.js). `invoke(entry, request)` names the entry; the function and its module
// are the release's (the entry model `aircloud test prepare` compiles), never the test's. An entry the
// release does not declare, or that declares no org_path, resolves to the host's refusal envelope
// (functions.org_path_undeclared) and the guest never runs.
//
// THE CORRELATION ID. Each invocation resolves one correlation id as the host's entry surface does
// (src/correlation.js, contracts/functions/v1/correlation-v1.json): the caller's x-correlation-id when
// it is a UUID, else a minted one. The guest's request carries it under that header, replacing the
// caller's value, and every capability call the invocation makes carries it on `world.calls` and on a
// refusal's envelope.
import { pathToFileURL } from "node:url";
import "../generated/platform-prelude.js";
import { CORRELATION_HEADER, resolveCorrelationId, withInvocation } from "./correlation.js";
import { DoubleMisuseError } from "./errors.js";
import { withRuntimeLocale } from "./runtime-locale.js";
import { withFrame } from "./semantics/invocation.js";
import { world } from "./world.js";

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
 * Invoke the function behind the declared `entry` — { route: prefix }, { function, event: topic, source?,
 * entity? }, { function, cron: schedule } or { function, orgPath? } (a direct invoke) — with `request` (a
 * Request, or a URL string). Resolves to the guest's Response, or to the host's refusal envelope when the
 * entry resolves to no node the host would act at.
 */
export async function invoke(entry, request) {
  const sent = typeof request === "string" ? new Request(request) : request;
  if (!(sent instanceof Request)) throw new DoubleMisuseError("invoke(entry, request): request must be a Request or a URL");
  const correlationId = resolveCorrelationId(sent.headers.get(CORRELATION_HEADER));
  const headers = new Headers(sent.headers);
  headers.set(CORRELATION_HEADER, correlationId);
  const resolved = await world.entries.resolve(entry, new Request(sent, { headers }));
  if (resolved.refusal) return refused(resolved.refusal, correlationId);
  const { module, request: req, frame } = resolved;
  return withInvocation(correlationId, () => withFrame(frame, () => withRuntimeLocale(() => dispatch(module, req))));
}

/** The host's answer to an invocation it refused before the guest ran (contracts/functions/v1/errors.json envelope). */
function refused({ status, code, message, details }, correlationId) {
  return new Response(JSON.stringify({ error: { code, message, correlation_id: correlationId, details } }), {
    status,
    headers: { "content-type": "application/json", [CORRELATION_HEADER]: correlationId },
  });
}

async function dispatch(module, req) {
  const url = pathToFileURL(module);
  url.searchParams.set("air-invocation", String(++invocation));

  const listeners = await evaluate(url);
  if (listeners.length === 0) throw new DoubleMisuseError(`${module} registers no fetch listener`);

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
