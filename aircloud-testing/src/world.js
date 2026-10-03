// @aircloudhq/testing — the in-memory world every capability double reads and writes.
//
// ONE world per process, shared by the generated `aircloud:capability/*` bindings a guest imports
// and by the test that seeds and inspects it (`import { world } from "@aircloudhq/testing"`). Both
// resolve this same module, so there is exactly one state. Call `world.reset()` in `beforeEach`:
// state never leaks between tests unless a test chooses to share it.
//
// THE ENVIRONMENT AXIS. A function runs either in `production` or in a non-production environment
// (a named preview, or the pipeline's `ci-*`). The platform's link-set is keyed on it (ADR-110
// facet 4, contracts/capability/v1/capabilities.json `sandbox_mode`): an `external` capability whose
// sandbox mode is `capture` never leaves the platform outside production — the guest receives the
// deterministic capture response instead. `world.environment` selects the same arm here, from the
// same contract data, so a test can prove its function behaves in both.
import { DoubleMisuseError } from "./errors.js";
import { createIdSource } from "./ids.js";
import { KNOWN_CODES } from "./codes.js";
import { CONTRACT } from "../generated/contract-data.js";
import { STATE_FACTORIES } from "./semantics/index.js";

function createClock() {
  let fixed = null;
  return {
    nowMs() { return fixed === null ? Date.now() : fixed; },
    now() { return new Date(this.nowMs()); },
    /** Freeze the clock at an instant (Date, ISO string or epoch ms); `null` returns to real time. */
    set(instant) {
      if (instant === null) { fixed = null; return; }
      const ms = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
      if (!Number.isFinite(ms)) throw new DoubleMisuseError(`clock.set: '${String(instant)}' is not an instant`);
      fixed = ms;
    },
    advance(ms) {
      if (fixed === null) fixed = Date.now();
      fixed += ms;
    },
  };
}

function createFaults() {
  let queue = [];
  return {
    /**
     * Make the next call(s) of `target` ("<interface>.<function>", WIT names) refuse with a
     * platform error envelope. `code` must be a code the platform can emit for this surface.
     */
    inject(target, { code, message, details } = {}, { times = 1 } = {}) {
      if (typeof target !== "string" || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(target)) {
        throw new DoubleMisuseError(`faults.inject: target '${String(target)}' is not "<interface>.<function>"`);
      }
      if (!KNOWN_CODES.has(code)) {
        throw new DoubleMisuseError(`faults.inject: '${String(code)}' is not an error code the platform emits`);
      }
      if (!Number.isInteger(times) || times < 1) throw new DoubleMisuseError("faults.inject: times must be a positive integer");
      queue.push({ target, code, message: message ?? `injected ${code}`, details: details ?? {}, left: times });
    },
    take(target) {
      const f = queue.find((x) => x.target === target);
      if (!f) return null;
      f.left--;
      if (f.left === 0) queue = queue.filter((x) => x !== f);
      return f;
    },
    pending() { return queue.map(({ target, code, left }) => ({ target, code, left })); },
    clear() { queue = []; },
  };
}

export function createWorld() {
  const w = {};
  /** The generated contract projection: gated meters, capture arms, codes, the WIT model. */
  w.contract = CONTRACT;
  w.reset = function reset() {
    w.clock = createClock();
    w.newId = createIdSource(w.clock);
    w.faults = createFaults();
    /** Every capability call, in order: { interface, function, capability, args, correlationId, outcome }. */
    w.calls = [];
    w.environment = "production";
    for (const [name, factory] of Object.entries(STATE_FACTORIES)) w[name] = factory(w);
    return w;
  };
  /**
   * The link-set arm `capability` resolves to in the current environment (ADR-110 facet 4, the
   * functions host's registry.select): `real` in production and for every non-external
   * capability; otherwise the capability's declared sandbox mode (`capture`, `deny`, `test-mode`).
   */
  w.linkArm = function linkArm(capability) {
    if (typeof w.environment !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(w.environment)) {
      throw new DoubleMisuseError(`world.environment '${String(w.environment)}' is not an environment name`);
    }
    const c = CONTRACT.capabilities[capability];
    if (!c) throw new Error(`@aircloudhq/testing defect: capability '${capability}' is not in the contract projection`);
    if (w.environment === "production" || c.effect !== "external") return "real";
    return c.sandboxMode;
  };
  return w.reset();
}

export const world = createWorld();
