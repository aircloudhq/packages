// @aircloudhq/testing — the authority projection and its ONE evaluation (#384 ADR-293 decisions 3, 5, 8
// and 9; contracts/auth/v1/authz-projection.json `selection` and `evaluation`), the in-memory mirror of
// flex/src/authz_projection.rs, fixed by the shared vectors contracts/auth/v1/grants-vectors.json (run by
// test/grants_vectors.test.mjs).
//
// THE PROJECTION. One tenant's node keys (status and the denies authored there) and principal keys (plane,
// kind and memberships — each a home, home roles, scopes, grants and denies). Authority is read from here
// and only here: never from a token or an assertion (ADR-293 decision 7). `world.projection` is the
// test's copy of it: `world.principal.signIn` places the signed-in end user's key, `endUser` /
// `serviceAccount` / `principal` place any other, `node` and `deny` shape the tree. A node the test names
// (a membership's home, an entered node, a declared one) exists, active, with its ancestors; a node it
// never names has no key, and every reader refuses it as `org_node_unknown` — absence is never "active".
//
// THE EVALUATION. The roles of the selected membership at a record's node N are its home roles when N is
// at or below the home, plus every unexpired grant reaching N and clipped to the home (a group grant never
// reaches past it), minus every role a deny binding N names; an op-deny binding N refuses its ops, before
// any allow (`verdict`). Expiry is judged at the request instant: a grant stops authorizing AT its exp.
import { DoubleMisuseError } from "../errors.js";

/** The refusal classes of the projection (`Refusal::reason`): each reader publishes its own code for them. */
export class AuthzRefusal extends Error {
  constructor(reason, message) {
    super(`${reason}: ${message}`);
    this.name = "AuthzRefusal";
    this.reason = reason;
    this.detail = message;
  }
}

const refuse = (reason, message) => new AuthzRefusal(reason, message);

/** `n` is at or below `a` — a SEGMENT comparison, never a string prefix (`/acme` is not below `/ac`). */
export function atOrBelow(n, a) {
  return a === "/" || n === a || (n.length > a.length && n.startsWith(a) && n[a.length] === "/");
}

/** The ancestors-or-self of a valid org_path, root first (`/acme/a` → `/`, `/acme`, `/acme/a`). */
export function chain(orgPath) {
  const out = ["/"];
  if (orgPath === "/") return out;
  let acc = "";
  for (const seg of orgPath.slice(1).split("/")) {
    acc += `/${seg}`;
    out.push(acc);
  }
  return out;
}

const PLANES = ["builder", "end_user", "service"];
const KINDS = ["end_user", "builder_member", "service_account", "verification_principal"];
const STATUSES = ["active", "archived"];
const DENY_OPS = ["entity.read", "entity.create", "entity.update", "entity.delete"];
const ROLE_RE = /^[a-z0-9][a-z0-9_-]*$/;

function shape(ok, what) {
  if (!ok) throw new DoubleMisuseError(`projection: ${what}`);
}
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const roleList = (v) => Array.isArray(v) && v.every((r) => typeof r === "string" && ROLE_RE.test(r));

function decodeDeny(d, bound) {
  shape(isObj(d) && roleList(d.roles) && Array.isArray(d.ops) && d.ops.every((o) => DENY_OPS.includes(o)), `a deny is {roles, ops ⊆ ${DENY_OPS.join("|")}, entity}`);
  shape(d.entity === null || (typeof d.entity === "string" && d.entity !== ""), "a deny's entity is null or a name");
  shape(d.roles.length > 0 || d.ops.length > 0, "a deny names at least one role or op");
  const orgPath = bound ?? d.org_path;
  shape(typeof orgPath === "string" && orgPath.startsWith("/"), "a membership's deny names its org_path");
  return { org_path: orgPath, roles: [...d.roles], ops: [...d.ops], entity: d.entity };
}

/** A principal key's value (`schemas.principal`), checked as the readers decode it. */
export function decodePrincipal(v) {
  shape(isObj(v) && PLANES.includes(v.plane) && KINDS.includes(v.kind), `a principal is {rev, plane ∈ ${PLANES.join("|")}, kind, memberships}`);
  shape(Array.isArray(v.memberships) && v.memberships.length > 0, "a principal holds at least one membership");
  return {
    plane: v.plane,
    kind: v.kind,
    memberships: v.memberships.map((m) => {
      shape(isObj(m) && typeof m.id === "string" && m.id !== "" && typeof m.home === "string" && m.home.startsWith("/"), "a membership is {id, home, home_roles, scopes, grants, denies}");
      shape(roleList(m.home_roles) && strings(m.scopes) && Array.isArray(m.grants) && Array.isArray(m.denies), `membership ${m.id}: home_roles, scopes, grants and denies are lists`);
      return {
        id: m.id,
        home: m.home,
        home_roles: [...m.home_roles],
        scopes: [...m.scopes],
        grants: m.grants.map((g) => {
          shape(isObj(g) && typeof g.org_path === "string" && roleList(g.roles), `membership ${m.id}: a grant is {org_path, roles, profile, via_group, exp}`);
          const exp = g.exp === null || g.exp === undefined ? null : Date.parse(g.exp);
          shape(exp === null || Number.isFinite(exp), `membership ${m.id}: a grant's exp is null or RFC 3339`);
          const profile = g.profile ?? null;
          shape(profile === null || (isObj(profile) && typeof profile.org_path === "string" && typeof profile.name === "string"), `membership ${m.id}: a grant's profile is {org_path, name}`);
          return {
            org_path: g.org_path,
            roles: [...g.roles],
            profile: profile && { org_path: profile.org_path, name: profile.name },
            via_group: g.via_group ?? null,
            exp,
            // The exp as the key carries it (RFC 3339) — what principal.grants answers as `expires-at`.
            expText: exp === null ? null : g.exp,
          };
        }),
        denies: m.denies.map((d) => decodeDeny(d)),
      };
    }),
  };
}

/** A node key's value (`schemas.node`): its status and the denies authored AT it. */
export function decodeNode(v) {
  shape(isObj(v) && STATUSES.includes(v.status) && Array.isArray(v.denies), "a node is {rev, status ∈ active|archived, denies}");
  return { status: v.status, denies: v.denies.map((d) => decodeDeny(d, "/")).map(({ roles, ops, entity }) => ({ roles, ops, entity })) };
}

/** A read-only tenant slice over decoded keys: [[org_path, node]] and [[sub, principal]]. */
export function projectionSlice(nodes, principals) {
  const n = new Map(nodes);
  const p = new Map(principals);
  return {
    node: (path) => n.get(path),
    principal: (sub) => p.get(sub),
    nodes: () => [...n],
  };
}

/**
 * Authenticate a principal value for a verified token's plane: an absent key, a value with no
 * membership, or a value of another plane refuses as unauthenticated.
 */
export function checkPrincipal(p, plane) {
  if (!p || p.memberships.length === 0) throw refuse("unauthenticated", "no authority projection key for the principal");
  if (p.plane !== plane) throw refuse("unauthenticated", `the principal's key is of plane ${p.plane}, the token of ${plane}`);
  return p;
}

/**
 * The request's membership (ADR-293 decision 9): the only one when none is requested; several require a
 * selection; a requested id naming no membership of THIS value is refused.
 */
export function selectMembership(p, requested) {
  if (requested === null || requested === undefined) {
    if (p.memberships.length === 1) return p.memberships[0];
    throw refuse("membership_required", `${p.memberships.length} memberships and no selection`);
  }
  const m = p.memberships.find((x) => x.id === requested);
  if (!m) throw refuse("membership_required", `'${requested}' is not a membership of this principal`);
  return m;
}

/** The node keys along `orgPath`'s chain, root first: archived or absent refuses; returns the chain's denies. */
export function nodeChain(view, orgPath) {
  const denies = [];
  for (const c of chain(orgPath)) {
    const n = view.node(c);
    if (!n) throw refuse("org_node_unknown", c);
    if (n.status === "archived") throw refuse("org_node_archived", c);
    for (const d of n.denies) denies.push({ org_path: c, ...d });
  }
  return denies;
}

/** The denies authored at the node keys STRICTLY below `orgPath` (those a record in its subtree sits under). */
export function subtreeDenies(view, orgPath) {
  const out = [];
  for (const [path, n] of view.nodes()) {
    if (path !== orgPath && atOrBelow(path, orgPath)) for (const d of n.denies) out.push({ org_path: path, ...d });
  }
  return out;
}

function dedup(denies) {
  const seen = new Map();
  for (const d of denies) seen.set(JSON.stringify([d.org_path, [...d.roles].sort(), [...d.ops].sort(), d.entity]), d);
  return [...seen.values()];
}

/**
 * The grants of membership `m` active at `nowMs` — a grant stops authorizing AT its exp (authz_projection
 * `Membership::active_grants`, #384 D105: what principal.grants lists).
 */
export function activeGrants(m, nowMs) {
  return m.grants.filter((g) => g.exp === null || nowMs < g.exp);
}

/**
 * The roles membership `m` holds EFFECTIVELY at node `n` at `nowMs` (authz_projection::membership_roles_at,
 * #384 D105: principal.roles-at): the evaluation's roles at `n`; nothing outside the home's subtree and
 * nothing at a node whose chain is archived or has no key (fail-closed).
 */
export function membershipRolesAt(view, m, n, nowMs) {
  if (!atOrBelow(n, m.home)) return [];
  let chainDenies;
  try {
    chainDenies = nodeChain(view, n);
  } catch (e) {
    if (!(e instanceof AuthzRefusal)) throw e;
    return [];
  }
  return rolesAt(authorityOf(m, chainDenies, nowMs), n);
}

/** The authority of membership `m` at instant `nowMs`: its unexpired grants, its denies ∪ `nodeDenies`. */
export function authorityOf(m, nodeDenies, nowMs) {
  return {
    home: m.home,
    home_roles: [...m.home_roles],
    scopes: [...m.scopes],
    grants: activeGrants(m, nowMs).map((g) => ({ org_path: g.org_path, roles: g.roles, viaGroup: g.via_group !== null })),
    denies: dedup([...m.denies, ...nodeDenies]),
  };
}

/** An actor with no membership (a node-kind invocation, the internal plane), bound only by `denies`. */
export function unhomed(denies) {
  return { home: null, home_roles: [], scopes: [], grants: [], denies: dedup(denies) };
}

/** The verdict at node `n` for `op` on `entity` (`evaluation`, the deciding rule in precedence order). */
export function verdict(a, n, op, entity) {
  const deniedRoles = new Set();
  let denied = false;
  for (const d of a.denies.filter((x) => atOrBelow(n, x.org_path))) {
    for (const r of d.roles) deniedRoles.add(r);
    if ((d.entity === null || d.entity === entity) && d.ops.includes(op)) denied = true;
  }
  const supplied = new Set();
  const surviving = new Set();
  const supply = (roles) => {
    let survived = false;
    for (const r of roles) {
      supplied.add(r);
      if (!deniedRoles.has(r)) {
        surviving.add(r);
        survived = true;
      }
    }
    return survived;
  };
  let homeSurvives = false;
  let membershipSurvives = false;
  let groupSurvives = false;
  let scopes = [];
  if (a.home !== null && atOrBelow(n, a.home)) {
    homeSurvives = supply(a.home_roles);
    scopes = [...a.scopes].sort();
    for (const g of a.grants.filter((x) => atOrBelow(n, x.org_path))) {
      if (supply(g.roles)) {
        if (g.viaGroup) groupSurvives = true;
        else membershipSurvives = true;
      }
    }
  }
  const removed = [...supplied].some((r) => deniedRoles.has(r));
  const rule = denied ? "deny.op"
    : removed ? "deny.role"
    : groupSurvives ? "grant.group"
    : membershipSurvives ? "grant.membership"
    : homeSurvives || scopes.length > 0 ? "home"
    : "none";
  return { roles: [...surviving].sort(), scopes, denied, rule };
}

/** The roles effective at node `n` (the verdict's roles; an op-deny removes no role). */
export function rolesAt(a, n) {
  return verdict(a, n, "entity.read", "").roles;
}

/**
 * An UPPER BOUND of the roles held at `n` or anywhere below it — what the executor checks BEFORE a record
 * is looked up (ADR-279 decision 3, #384 D41), the exact check at the record's node following the read.
 */
export function rolesReachableBelow(a, n) {
  const comparable = (x) => atOrBelow(n, x) || atOrBelow(x, n);
  const out = new Set();
  if (a.home !== null && comparable(a.home)) {
    for (const r of a.home_roles) out.add(r);
    for (const g of a.grants.filter((x) => comparable(x.org_path))) for (const r of g.roles) out.add(r);
  }
  for (const d of a.denies.filter((x) => atOrBelow(n, x.org_path))) for (const r of d.roles) out.delete(r);
  return out;
}

/** The deepest of `paths` when they all lie on one chain, or null when two of them sit beside each other. */
function deepest(paths) {
  const d = paths.reduce((a, b) => (chain(b).length > chain(a).length ? b : a));
  return paths.every((p) => atOrBelow(d, p)) ? d : null;
}

/**
 * The roles membership `m` holds EFFECTIVELY at `at` or at some node below it, at `nowMs` — the exact set,
 * never the upper bound `rolesReachableBelow` gives (web-origin/src/route_roles.rs `effective_at_or_below`,
 * ADR-292 decision 1): a role effective below `at` is supplied by one term (the home, or a grant), so it is
 * effective at the deepest of that term's node, the home and `at`; a candidate whose chain is archived or
 * has no key holds nothing (fail-closed).
 */
export function effectiveAtOrBelow(view, m, at, nowMs) {
  const candidates = new Set([m.home, ...m.grants.map((g) => g.org_path)].map((t) => deepest([t, m.home, at])).filter((c) => c !== null));
  const out = new Set();
  for (const c of candidates) for (const r of membershipRolesAt(view, m, c, nowMs)) out.add(r);
  return out;
}

/** Whether an op-deny binding node `n` refuses `op` on `entity`. */
export function denied(a, n, op, entity) {
  return a.denies.some((d) => atOrBelow(n, d.org_path) && d.ops.includes(op) && (d.entity === null || d.entity === entity));
}

/**
 * Select the membership `requested` names and evaluate its authority at `node` for `op` on `entity` at
 * `nowMs`: the home's chain and the node's chain must be active; the denies binding the node are the
 * chain's united with the membership's own.
 */
export function evaluate(p, view, requested, node, op, entity, nowMs) {
  const m = selectMembership(p, requested);
  nodeChain(view, m.home);
  return verdict(authorityOf(m, nodeChain(view, node), nowMs), node, op, entity);
}

// ── the test's projection (world.projection) ──────────────────────────────────────────────────────

/** The function runtime's service account — the bearer of every function's Flex calls (ADR-242). */
export const RUNTIME_SUB = "function-runtime";

export function createProjectionState() {
  const nodes = new Map();
  const principals = new Map();
  /** The chain of `path`, each node placed active unless the test already placed it. */
  const ensureChain = (path) => {
    shape(typeof path === "string" && path.startsWith("/"), `'${String(path)}' is not an org node`);
    for (const c of chain(path)) if (!nodes.has(c)) nodes.set(c, { status: "active", denies: [] });
  };
  const place = (sub, value) => {
    shape(typeof sub === "string" && sub !== "", "a principal key needs its sub");
    const p = decodePrincipal({ rev: 1, ...value });
    for (const m of p.memberships) ensureChain(m.home);
    principals.set(sub, p);
    return p;
  };
  /** A membership written the short way: grants and denies default to none, a grant's exp to never. */
  const membership = (m) => ({
    id: m.id,
    home: m.home,
    home_roles: m.home_roles ?? [],
    scopes: m.scopes ?? [],
    grants: (m.grants ?? []).map((g) => ({ org_path: g.org_path, roles: g.roles, profile: g.profile ?? null, via_group: g.via_group ?? null, exp: g.exp ?? null })),
    denies: m.denies ?? [],
  });
  const state = {
    /** Place the node key at `path` ({status, denies} — denies authored AT it), its ancestors active. */
    node(path, { status = "active", denies = [] } = {}) {
      ensureChain(path);
      nodes.set(path, decodeNode({ rev: 1, status, denies }));
    },
    /** Author a deny at `deny.org_path` ({org_path, roles, ops, entity}), as a tenant:org holder does. */
    deny(deny) {
      ensureChain(deny.org_path);
      const n = nodes.get(deny.org_path);
      const [d] = decodeNode({ rev: 1, status: n.status, denies: [{ roles: deny.roles, ops: deny.ops, entity: deny.entity ?? null }] }).denies;
      nodes.set(deny.org_path, { ...n, denies: [...n.denies, d] });
    },
    /** Place any principal key ({plane, kind, memberships} in the published shape). */
    principal(sub, value) {
      return place(sub, value);
    },
    /** An end user's key: its memberships ({id, home, home_roles, scopes, grants: [{org_path, roles, exp, via_group}], denies}). */
    endUser(sub, memberships) {
      shape(Array.isArray(memberships), "endUser(sub, memberships): memberships is a list");
      return place(sub, { plane: "end_user", kind: "end_user", memberships: memberships.map(membership) });
    },
    /** A service account's key: one implicit membership at `home`, holding `scopes`. */
    serviceAccount(sub, home, scopes = []) {
      return place(sub, { plane: "service", kind: "service_account", memberships: [membership({ id: `sa-${sub}`, home, scopes })] });
    },
    /** A Builder member's key: one implicit membership at `/`. */
    builder(sub, scopes = []) {
      return place(sub, { plane: "builder", kind: "builder_member", memberships: [membership({ id: `am-${sub}`, home: "/", scopes })] });
    },
    /** Erase the node key at `path` and every key below it (a deleted node, ADR-295 decision 7). */
    remove(path) {
      for (const p of [...nodes.keys()]) if (atOrBelow(p, path)) nodes.delete(p);
    },
    /** Make `path` exist (active) with its ancestors, unless the test placed it already. */
    ensure(path) {
      ensureChain(path);
    },
    /** The tenant slice the readers evaluate. */
    view() {
      return { node: (p) => nodes.get(p), principal: (s) => principals.get(s), nodes: () => [...nodes] };
    },
  };
  // The runtime's own key: the service account every function's Flex calls carry, at the root.
  state.serviceAccount(RUNTIME_SUB, "/");
  return state;
}
