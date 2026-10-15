// @aircloudhq/testing — the ONE acting-principal resolution of a Flex request (ADR-257 decisions 2 and 8),
// the in-memory mirror of flex/src/auth.rs `resolve_acting_principal`, fixed by the shared vectors
// contracts/flex/v1/acting-principal-vectors.json (run by test/flex_owner_vectors.test.mjs):
//
//   - an `end_user`-plane bearer acts as itself (its sub, roles and node);
//   - a `service`-plane bearer carrying a verified functions-host end-user assertion acts as the asserted
//     end user (its sub, roles, node and act);
//   - any other bearer acts as itself — the tenant, or a principal the tenant authorized;
//   - an assertion beside any bearer other than `service` is refused (flex.unauthenticated): two end users
//     in one request is malformed, never resolved.
import { CapabilityFailure } from "../errors.js";

function unauthenticated(message) {
  return new CapabilityFailure("flex.unauthenticated", message, {});
}

/** An end_user bearer's roles: absent is none; anything but an array of text is refused. */
function endUserRoles(raw) {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw unauthenticated("roles claim is not an array");
  if (!raw.every((r) => typeof r === "string")) throw unauthenticated("roles claim carries a non-text role");
  return [...raw];
}

/**
 * The acting principal of a request.
 * @param {{plane: string, sub: string, roles: unknown, org_path: string, act?: unknown}} bearer the verified bearer
 * @param {{sub: string, roles: string[], org_path: string, act: unknown} | null} assertion the verified assertion
 * @returns {{acting: "end_user", source: "bearer"|"assertion", sub: string, roles: string[], org_path: string, act: unknown}
 *   | {acting: "bearer", sub: string, org_path: string}}
 */
export function resolveActingPrincipal(bearer, assertion) {
  if (assertion) {
    if (bearer.plane !== "service") {
      throw unauthenticated(`an end-user assertion is admitted only beside a service bearer, not ${bearer.plane}`);
    }
    return { acting: "end_user", source: "assertion", sub: assertion.sub, roles: [...assertion.roles], org_path: assertion.org_path, act: assertion.act ?? null };
  }
  if (bearer.plane === "end_user") {
    return { acting: "end_user", source: "bearer", sub: bearer.sub, roles: endUserRoles(bearer.roles), org_path: bearer.org_path, act: bearer.act ?? null };
  }
  return { acting: "bearer", sub: bearer.sub, org_path: bearer.org_path };
}

/** `node` is `parent` or one of its descendants — a literal prefix comparison on whole segments. */
export function atOrBelow(node, parent) {
  return parent === "/" || node === parent || node.startsWith(`${parent}/`);
}
