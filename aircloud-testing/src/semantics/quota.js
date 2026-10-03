// @aircloudhq/testing — the wallet as the capabilities see it: the `quota.check` probe and the
// admission debit every gated capability passes through.
//
// TWO SURFACES, ONE BALANCE, as on the platform:
//   * `quota.check` is an effect-NONE read (ADR-164, functions/src/caps_quota.rs): it consumes
//     nothing, and a non-member action is `functions.validation`. A meter with no provisioned
//     pool is a definitive ABSENT key, which the probe answers as an allow with no `remaining`.
//   * a gated capability (a Flex write, a query, a mail send) is ADMITTED under its meter before it
//     runs, and a refusal is that capability's own quota code (`flex.quota_exhausted`,
//     `comms.quota_exceeded`) carrying the refusal provenance (#602) in `details.quota`.
//
// The gated-meter vocabulary is the metering registry's (contracts/metering/v1/meter-registry.json
// `gated: true`), generated into this package — an action outside it is refused exactly as the
// probe refuses it.
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";

const POLICIES = ["hard_block", "allow_overage", "warn_upgrade"];
const QUOTA_CODES = { flex: "flex.quota_exhausted", comms: "comms.quota_exceeded" };

export function createQuotaState(world) {
  const pools = new Map(); // meter → { balance, limit, policy, grain, retryAfterSeconds } | { unprovisioned: true }
  let suspended = false;

  function requireGated(meter) {
    if (!world.contract.gatedMeters.includes(meter)) {
      throw new DoubleMisuseError(`quota: '${meter}' is not a gated meter of contracts/metering/v1/meter-registry.json`);
    }
  }

  /** The outcome of charging `units` against `meter`, WITHOUT mutating. */
  function judge(meter, units) {
    const p = pools.get(meter);
    if (!p) return { allowed: true, remaining: undefined };
    if (p.unprovisioned) return { allowed: false, reason: "no-level-provisioned", pool: null, p };
    const wouldBe = p.balance - BigInt(units);
    if (wouldBe >= 0n) return { allowed: true, remaining: wouldBe, p };
    if (p.policy === "hard_block") return { allowed: false, reason: "exhausted", pool: p, p };
    return { allowed: true, remaining: undefined, p };
  }

  function entitlement(p) {
    return { value: { tag: "number", val: p.limit }, policy: p.policy, sourceGrain: p.grain };
  }

  const state = {
    /**
     * Provision a pool for a gated meter. `balance` is the units left; `policy` is the plan's
     * failure posture; `limit` is the entitlement the refusal reports (defaults to `balance`).
     */
    set(meter, { balance, limit, policy = "hard_block", grain = "/", retryAfterSeconds = 0 } = {}) {
      requireGated(meter);
      if (typeof balance !== "bigint" && !Number.isInteger(balance)) throw new DoubleMisuseError("quota.set: balance must be an integer or bigint");
      if (!POLICIES.includes(policy)) throw new DoubleMisuseError(`quota.set: policy must be one of ${POLICIES.join(", ")}`);
      const lim = limit === undefined ? Number(balance) : limit;
      pools.set(meter, { balance: BigInt(balance), limit: lim, policy, grain, retryAfterSeconds });
    },
    /** No level of the org chain resolves a pool for this meter (the `no-level-provisioned` refusal). */
    unprovisioned(meter, { limit = 0, policy = "hard_block", grain = "/", retryAfterSeconds = 0 } = {}) {
      requireGated(meter);
      pools.set(meter, { unprovisioned: true, limit, policy, grain, retryAfterSeconds });
    },
    balance(meter) {
      const p = pools.get(meter);
      return p && !p.unprovisioned ? p.balance : undefined;
    },
    suspend() { const s = suspended; suspended = true; return s; },
    resume(saved) { suspended = saved; },

    /** Admission: debit `units` or refuse with the family's quota code. */
    admit(meter, units, family) {
      if (suspended) return;
      const j = judge(meter, units);
      if (j.allowed) {
        if (j.p && !j.p.unprovisioned) j.p.balance -= BigInt(units);
        return;
      }
      const p = j.p;
      if (family === "comms") {
        // pipeline.go: 429 comms.quota_exceeded, "quota exceeded for <meter>", no details.
        throw new CapabilityFailure(QUOTA_CODES.comms, `quota exceeded for ${meter}`, {});
      }
      // exec.rs admission → ApiError::quota_exhausted: the #602 provenance under details.quota.
      throw new CapabilityFailure(QUOTA_CODES.flex, "quota exhausted", {
        quota: {
          meter,
          reason: j.reason === "exhausted" ? "exhausted" : "no_level_provisioned",
          pool: j.pool ? { grain: p.grain, dimension: "{}", balance: Number(p.balance) } : null,
          entitlement: { value: p.limit, policy: p.policy, source_grain: p.grain },
        },
      });
    },

    // ── the WIT surface ──────────────────────────────────────────────────────────────────
    check(req) {
      if (!world.contract.gatedMeters.includes(req.action)) {
        throw new CapabilityFailure(
          "functions.validation",
          "quota.check requires an action that is an active gated registry member",
          // Never echoed (caps_quota.rs): the envelope must not enumerate the registry.
          {},
        );
      }
      const j = judge(req.action, 1);
      if (j.allowed) {
        return { tag: "allowed", val: j.remaining === undefined || j.remaining < 0n ? {} : { remaining: j.remaining } };
      }
      const p = j.p;
      return {
        tag: "refused",
        val: {
          reason: j.reason,
          ...(j.pool ? { pool: { grain: p.grain, dimension: "{}", balance: p.balance } } : {}),
          entitlement: entitlement(p),
          retryAfterSeconds: p.retryAfterSeconds,
        },
      };
    },
  };
  return state;
}

/** Admit a gated action on behalf of a capability semantics (see createQuotaState.admit). */
export function admit(world, meter, units, family) {
  world.quota.admit(meter, units, family);
}
