// @aircloudhq/testing — the keyed effects of the bus and Flex capabilities (ADR-302 decision 8; design
// 2026-11-05-platform-effect-idempotency D2, D4, D12-D15): the derived ids, the request digests and the key
// memories the double keeps, mirroring the capability gateway (capgw/buspublish.go) and flex-jit (flex/src/api.rs,
// exec.rs). The ids are held to contracts/durability/v1/idv5-vectors.json and the digests to
// request-digest-vectors.json (test/keys.test.mjs).
//
// A key is scoped on (tenant, acting node, environment, acting principal) — the principal is `plane ‖ sub ‖ the
// asserted end-user sub (empty when none)` — so a key names one effect of one principal: a replay answers only its
// own principal, and another principal's identical key collides with nothing.
import { CapabilityFailure } from "../errors.js";
import { canonicalJSON, canonicalizeValue, Composite, IJsonError } from "../canonical-json.js";
import { IDEMPOTENCY_KEY_REFUSAL, validIdempotencyKey } from "../idempotencykey_gen.js";
import { idv5, scopedKey } from "../idv5.js";
import { NS_BUS_APP_EVENT, NS_FLEX_MUTATION } from "../namespaces_gen.js";

/** The derived bus event id: IDv5(NS_BUS_APP_EVENT, tenant ‖ node ‖ environment ‖ plane ‖ sub ‖ act ‖ topic ‖ key). */
export function busEventId(tenantId, orgPath, environment, principal, topic, key) {
  return idv5(NS_BUS_APP_EVENT, scopedKey(tenantId, orgPath, environment, principal.plane, principal.sub, principal.act, topic, key));
}

/** The derived Flex mutation key id: IDv5(NS_FLEX_MUTATION, tenant ‖ node ‖ environment ‖ plane ‖ sub ‖ act ‖ key). */
export function flexMutationKeyId(tenantId, orgPath, environment, principal, key) {
  return idv5(NS_FLEX_MUTATION, scopedKey(tenantId, orgPath, environment, principal.plane, principal.sub, principal.act, key));
}

/** The key's grammar, refused in the executor's own validation envelope (`<code>`, details.field idempotency_key). */
export function checkKey(code, key) {
  if (!validIdempotencyKey(key)) throw new CapabilityFailure(code, IDEMPOTENCY_KEY_REFUSAL, { field: "idempotency_key" });
}

/** A caller's I-JSON document, canonical; a document that is not I-JSON is the executor's validation refusal. */
export function canonicalDocument(code, text, field) {
  try {
    return canonicalJSON(text);
  } catch (e) {
    if (e instanceof IJsonError) {
      throw new CapabilityFailure(code, `the document is not I-JSON (${e.reason})`, { field, reason: e.reason });
    }
    throw e;
  }
}

/** The SHA-256 (hex) of a composite request: each field uvarint(len) ‖ bytes, in order. */
export function compositeDigest(...fields) {
  const c = new Composite();
  for (const f of fields) c.str(f);
  return c.sum().toString("hex");
}

/** The Flex request digest (design § 5.6): operation, entity, the record or field name (or ""), the validated document. */
export function flexRequestDigest(operation, entity, name, validated) {
  return compositeDigest(operation, entity, name ?? "", validated === undefined ? "" : canonicalizeValue(validated));
}

/**
 * The Flex route digest (flex-jit's mutation::RouteRequest, lane C's review round I2): the request as its route
 * carried it — the operation, the entity the path names ("" for an entity create), the record id or field name the
 * path names, the canonical raw document ("" when none). For a delete it is the request digest itself.
 */
export function flexRouteDigest(operation, entity, name, canonicalDoc) {
  return compositeDigest(operation, entity, name ?? "", canonicalDoc ?? "");
}

/** The operations whose route IS their request (no document; the path names the target). */
const ROUTE_IS_REQUEST = new Set(["record.delete", "entity.delete", "field.delete"]);

/**
 * The Flex key memory: a mutation applied under a key binds it — a replay with the same digest answers the stored
 * answer (no policy, no wallet, no event), a different digest is flex.idempotency_key_reused — and a refused
 * mutation binds nothing (the write runs before the key is recorded, and a throw records nothing).
 */
export function createFlexKeyMemory(world) {
  const applied = new Map();
  return {
    /** Every applied key, for a test to assert on: [{keyId, operation, entity, recordId, appliedAt}]. */
    get applied() { return [...applied.values()].map(({ answer, digest, route, ...rest }) => ({ ...rest })); },
    reset() { applied.clear(); },
    /**
     * The route's answer from the key, before anything that depends on mutable state is read (flex-jit's
     * Db::replay_route): an exact retry of an applied mutation answers its stored answer — after its entity is gone —
     * and a delete's key reused for another target is refused by name. `undefined`: continue to the mutation.
     */
    replay(key, scope, route) {
      checkKey("flex.validation", key);
      const keyId = flexMutationKeyId(world.tenantId, scope.orgPath, world.environment, scope.principal, key);
      const prior = applied.get(keyId);
      if (!prior) return undefined;
      if (prior.route === route) return prior.answer;
      if (ROUTE_IS_REQUEST.has(prior.operation) && prior.digest !== route) {
        throw new CapabilityFailure("flex.idempotency_key_reused", "the idempotency key already names a different mutation", {
          operation: prior.operation, entity: prior.entity, record_id: prior.recordId, applied_at: prior.appliedAt,
        });
      }
      return undefined;
    },
    /**
     * Run `write` under the key: `scope` is {orgPath, principal}; `request` {operation, entity, name, validated, route}
     * (`route` the route digest, flexRouteDigest).
     * `write` returns {answer, recordId?}.
     */
    run(key, scope, request, write) {
      checkKey("flex.validation", key);
      const keyId = flexMutationKeyId(world.tenantId, scope.orgPath, world.environment, scope.principal, key);
      const digest = flexRequestDigest(request.operation, request.entity, request.name, request.validated);
      const prior = applied.get(keyId);
      if (prior) {
        if (prior.digest !== digest) {
          throw new CapabilityFailure("flex.idempotency_key_reused", "the idempotency key already names a different mutation", {
            operation: prior.operation, entity: prior.entity, record_id: prior.recordId, applied_at: prior.appliedAt,
          });
        }
        return prior.answer;
      }
      const { answer, recordId } = write();
      applied.set(keyId, {
        keyId, digest, route: request.route ?? digest, answer, operation: request.operation, entity: request.entity,
        recordId: recordId ?? null, appliedAt: new Date(world.clock.nowMs()).toISOString(),
      });
      return answer;
    },
  };
}
