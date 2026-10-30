// @aircloudhq/testing — the ONE acting-principal resolution of a Flex request (ADR-257 decisions 2 and 8,
// as amended by ADR-293 decisions 7 to 9 and ADR-295 decisions 3 and 4), the in-memory mirror of
// flex/src/auth.rs `parse_host_assertion` and `resolve_acting_principal`, fixed by the shared vectors
// contracts/flex/v1/acting-principal-vectors.json (run by test/flex_owner_vectors.test.mjs):
//
//   - an assertion is admitted beside a `service` bearer only (flex.unauthenticated otherwise);
//   - its kind shape: `kind` is one of the contract's, every claim present is one the kind admits (the
//     retired `roles` excepted — ignored, never read), and the kind's required claims are present;
//   - the bounds: entry ⊆ the bearer's node (its projection key's home), acting ⊆ entry, and for an end
//     user the selected membership is the sub's and is homed AT the entry;
//   - an `end_user`-plane bearer acts as itself through the membership it selects (X-Air-Membership);
//     any other bearer acts as itself at its implicit membership's home (the internal plane at its node);
//   - AUTHORITY IS READ FROM THE PROJECTION — never from a token or an assertion — and an archived or
//     unknown node on a chain the resolution reads refuses (flex.org_node_archived).
import { CapabilityFailure } from "../errors.js";
import { validOrgPath } from "./acting-node.js";
import {
  atOrBelow, AuthzRefusal, authorityOf, checkPrincipal, nodeChain, selectMembership, subtreeDenies, unhomed,
} from "./authz.js";

export { atOrBelow };

/** A resolution refusal: its published code, its details, and its class (`reason`, the vectors' vocabulary). */
function refusal(code, message, reason, details = {}) {
  const e = new CapabilityFailure(code, message, details);
  e.reason = reason;
  return e;
}

function unauthenticated(message) {
  return refusal("flex.unauthenticated", message, "unauthenticated");
}

/**
 * The published answer of a projection refusal (flex/src/api.rs `resolve_refusal`, #384 C11): one code per
 * refusal class; an unauthenticated one carries its class under details.reason.
 */
function published(e) {
  if (!(e instanceof AuthzRefusal)) return e;
  switch (e.reason) {
    case "membership_required": return refusal("flex.membership_required", e.detail, e.reason);
    case "org_node_archived":
    case "org_node_unknown": return refusal("flex.org_node_archived", e.detail, e.reason);
    default: return refusal("flex.unauthenticated", e.detail, e.reason, { reason: e.reason });
  }
}

/** Run `fn`, answering a projection refusal in its published form. */
function projected(fn) {
  try {
    return fn();
  } catch (e) {
    throw published(e);
  }
}

/**
 * The kind shape of a functions-host assertion whose signature and bindings verified (flex/src/auth.rs
 * `parse_host_assertion`, `verification` `kind_shape`), against `contract` — the generated projection of
 * contracts/flex/v1/end-user-assertion.json (`CONTRACT.hostAssertion`). Refusals are flex.unauthenticated.
 */
export function parseHostAssertion(claims, contract) {
  const no = (m) => unauthenticated(`assertion refused: ${m}`);
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) throw no("not a claim set");
  const kind = claims.kind;
  if (typeof kind !== "string") throw no("no kind");
  if (!contract.kinds.includes(kind)) throw no(`kind '${kind}' is not one of the contract's`);
  const extra = Object.keys(claims).find((k) => !(contract.claimKinds[k] ?? []).includes(kind) && !contract.retiredClaims.includes(k));
  if (extra !== undefined) throw no(`claim '${extra}' is not admitted on kind ${kind}`);
  const path = (k) => {
    if (!(k in claims)) return null;
    if (typeof claims[k] !== "string" || !validOrgPath(claims[k])) throw no(`${k} is not an org node`);
    return claims[k];
  };
  const text = (k) => {
    if (!(k in claims)) return null;
    if (typeof claims[k] !== "string" || claims[k] === "") throw no(`${k} is not a non-empty string`);
    return claims[k];
  };
  const texts = (k) => {
    const v = claims[k];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw no(`${k} is not an array of text`);
    return [...v];
  };
  const entry = path("entry_org_path");
  if (entry === null) throw no("no entry_org_path");
  const orgPath = path("org_path");
  const sub = text("sub");
  const membershipId = text("membership_id");
  const act = claims.act ?? null;
  if (act !== null && (typeof act !== "object" || Array.isArray(act))) throw no("act is not an object");
  let elevation = null;
  if (kind === "end_user") {
    if (sub === null || membershipId === null) throw no("an end_user assertion carries sub and membership_id");
  } else if (kind === "node") {
    if (orgPath === null) throw no("a node assertion carries its acting org_path");
  } else {
    if ((sub === null) !== (membershipId === null)) throw no("an elevation carries membership_id exactly when it carries sub");
    if (sub === null && orgPath === null) throw no("an elevation with no end user carries its acting org_path");
    const ops = texts("ops");
    if (ops.length === 0 || !ops.every((o) => contract.aggregateFns.includes(o))) throw no("elevation ops is a non-empty subset of the aggregate functions");
    if (!contract.elevationScopes.includes(claims.scope)) throw no(`elevation scope is one of ${contract.elevationScopes.join(", ")}`);
    const fn = text("function");
    if (fn === null) throw no("no function");
    const entity = text("entity");
    if (entity === null) throw no("no entity");
    elevation = { function: fn, entity, ops, filter: texts("filter"), group_by: texts("group_by"), fields: texts("fields"), scope: claims.scope };
  }
  return { kind, entry_org_path: entry, org_path: orgPath, sub, membership_id: membershipId, act, elevation };
}

/**
 * The invocation claims every kind carries (flex/src/auth.rs `invocation_claims`, #384 D78/D82): the
 * cause, a uuid, and the request surface, one of the contract's — read with the bindings, so the
 * request's surface is the verified assertion's and nothing else's. Refusals are flex.unauthenticated.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function invocationClaims(claims, contract) {
  const no = (m) => unauthenticated(`assertion refused: ${m}`);
  if (typeof claims.causation_id !== "string" || !UUID.test(claims.causation_id)) throw no("causation_id is not a uuid");
  if (!contract.surfaces.includes(claims.surface)) throw no("surface is not one of the grammar's surfaces");
  return { causationId: claims.causation_id, surface: claims.surface };
}

/** The authority of membership `m` acting at `acting`: both chains active; the denies of its reach. */
function authorityAt(view, m, acting, nowMs) {
  nodeChain(view, m.home);
  const denies = [...nodeChain(view, acting), ...subtreeDenies(view, acting)];
  return authorityOf(m, denies, nowMs);
}

/**
 * The acting principal of a request, from its verified `bearer` ({plane, sub, org_path on the internal
 * plane only}), the parsed host `assertion` (or null), the X-Air-Membership header (or null) and the
 * tenant's projection `view`, at `nowMs`. Returns
 *   {acting: "end_user", source, sub, membership_id, org_path, entry_org_path, act, authority, elevation?}
 *   {acting: "node", source: "assertion", sub, org_path, entry_org_path, authority, elevation?}
 *   {acting: "bearer", sub, org_path, authority}
 * or throws its published refusal (CapabilityFailure carrying `reason`).
 */
export function resolveActingPrincipal(bearer, assertion, xAirMembership, view, nowMs) {
  if (bearer.plane === "internal") {
    if (assertion) throw unauthenticated("an assertion is admitted only beside a service bearer, not internal");
    return { acting: "bearer", sub: bearer.sub, org_path: bearer.org_path ?? "/", authority: unhomed([]) };
  }
  if (assertion && bearer.plane !== "service") {
    throw unauthenticated(`an assertion is admitted only beside a service bearer, not ${bearer.plane}`);
  }
  return projected(() => {
    const own = checkPrincipal(view.principal(bearer.sub), bearer.plane);
    if (!assertion) {
      // The bearer acts as itself: an end user selects among its memberships; a Builder or a service
      // account holds exactly one, implicit.
      const m = selectMembership(own, bearer.plane === "end_user" ? xAirMembership : null);
      const authority = authorityAt(view, m, m.home, nowMs);
      if (bearer.plane === "end_user") {
        return {
          acting: "end_user", source: "bearer", sub: bearer.sub, membership_id: m.id,
          org_path: m.home, entry_org_path: m.home, act: bearer.act ?? null, authority,
        };
      }
      return { acting: "bearer", sub: bearer.sub, org_path: m.home, authority };
    }
    // entry ⊆ bearer (`verification` `entry_within_bearer`).
    const bearerNode = selectMembership(own, null).home;
    if (!atOrBelow(assertion.entry_org_path, bearerNode)) {
      throw unauthenticated(`entry ${assertion.entry_org_path} is outside the bearer's node ${bearerNode}`);
    }
    const withElevation = (r) => (assertion.elevation ? { ...r, elevation: assertion.elevation } : r);
    if (assertion.sub !== null && assertion.membership_id !== null) {
      // `membership`: the asserted membership is the sub's, homed AT the entry node.
      const user = checkPrincipal(view.principal(assertion.sub), "end_user");
      const m = selectMembership(user, assertion.membership_id);
      if (m.home !== assertion.entry_org_path) {
        throw unauthenticated(`the membership's home ${m.home} is not the entry ${assertion.entry_org_path}`);
      }
      const acting = assertion.org_path ?? m.home;
      if (!atOrBelow(acting, assertion.entry_org_path)) {
        throw unauthenticated(`acting node ${acting} is outside the entry ${assertion.entry_org_path}`);
      }
      return withElevation({
        acting: "end_user", source: "assertion", sub: assertion.sub, membership_id: m.id,
        org_path: acting, entry_org_path: assertion.entry_org_path, act: assertion.act, authority: authorityAt(view, m, acting, nowMs),
      });
    }
    if (assertion.sub !== null || assertion.membership_id !== null) {
      throw unauthenticated("an assertion carries membership_id exactly when it carries sub");
    }
    const acting = assertion.org_path;
    if (acting === null) throw unauthenticated("a node assertion carries its acting node");
    if (!atOrBelow(acting, assertion.entry_org_path)) {
      throw unauthenticated(`acting node ${acting} is outside the entry ${assertion.entry_org_path}`);
    }
    const denies = [...nodeChain(view, acting), ...subtreeDenies(view, acting)];
    return withElevation({
      acting: "node", source: "assertion", sub: bearer.sub, org_path: acting, entry_org_path: assertion.entry_org_path, authority: unhomed(denies),
    });
  });
}
