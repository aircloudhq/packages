// @aircloudhq/testing — a test principal's grants (#384 plan item I4; ADR-262 test principals, ADR-293
// decision 3), the grants half of world.principal.signIn's one-membership form: test/principals.toml's
// `grants = [{ node, profile, expires }]`, each a base profile of config/profiles.toml held at `node` — at
// or below the principal's home — until `expires` (RFC 3339; absent: never). The double reads no product
// file, so each grant also carries the profile's `roles`: what config/profiles.toml gives it, and what the
// release model resolves for release verification. The result is the projection's grant shape
// (contracts/auth/v1/authz-projection.json): {org_path, roles, profile: {org_path: "/", name}, via_group,
// exp} — a base profile is defined at `/`, where production activation converges it.
import { DoubleMisuseError } from "../errors.js";
import { atOrBelow } from "./authz.js";
import { validOrgPath } from "./acting-node.js";

const GRANT_KEYS = new Set(["node", "profile", "roles", "expires"]);

/** The projection grants of a test principal homed at `home`, from signIn's `grants` (a misuse refuses). */
export function testPrincipalGrants(home, grants) {
  const misuse = (m) => {
    throw new DoubleMisuseError(`principal.signIn: ${m}`);
  };
  if (grants === undefined) return [];
  if (!Array.isArray(grants)) misuse("grants is a list of { node, profile, roles, expires? }");
  return grants.map((g, i) => {
    if (g === null || typeof g !== "object" || Array.isArray(g)) misuse(`grants[${i}] is { node, profile, roles, expires? }`);
    for (const k of Object.keys(g)) if (!GRANT_KEYS.has(k)) misuse(`grants[${i}]: '${k}' is not a grant key (node, profile, roles, expires)`);
    if (!validOrgPath(g.node)) misuse(`grants[${i}]: node '${String(g.node)}' is not an org node`);
    if (!atOrBelow(g.node, home)) misuse(`grants[${i}]: node ${g.node} is not at or below the home ${home} (ADR-293 decision 3)`);
    if (typeof g.profile !== "string" || g.profile === "") misuse(`grants[${i}]: profile names a base profile of config/profiles.toml`);
    if (!Array.isArray(g.roles) || g.roles.length === 0 || !g.roles.every((r) => typeof r === "string" && r !== "")) {
      misuse(`grants[${i}]: roles are the profile's roles, a non-empty list of role keys`);
    }
    let exp = null;
    if (g.expires !== undefined) {
      const at = typeof g.expires === "string" && /(Z|[+-]\d{2}:\d{2})$/.test(g.expires) ? Date.parse(g.expires) : Number.NaN;
      if (!Number.isFinite(at)) misuse(`grants[${i}]: expires '${String(g.expires)}' is not an RFC 3339 instant with an offset`);
      exp = g.expires;
    }
    return { org_path: g.node, roles: [...g.roles], profile: { org_path: "/", name: g.profile }, via_group: null, exp };
  });
}
