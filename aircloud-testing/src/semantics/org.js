// @aircloudhq/testing — the tree capabilities (#384 F3, ADR-295 decision 6; functions/src/caps_org.rs at
// the host, the control-plane org-tree API behind it).
//
// THE DECLARATION. A function calls only the tree operations it declares in function.toml
// `[org] operations`; `world.org.declare([...])` stands for that list. Each operation IS a registry
// capability name (`nodes.create`, `members.revoke_grant`, …) — the double derives the vocabulary from
// the contract projection (`capabilityOf` over the tree interfaces), so a name outside it is the test's
// mistake (on the platform `aircloud check` refuses it, org.operation_unknown). An undeclared call is
// refused `capability.forbidden` naming the operation, before anything is touched — as the host does.
//
// THE AUTHORITY (ADR-293 decision 6, ADR-295 decision 6 / D7). The API judges every call with the
// authority of the invocation's ACTING node (`acting-node.current`, narrowing included): placement — a
// member, a profile, a group, a grant — at or below it, node lifecycle and deny authorship strictly
// below it. A target outside answers the API's own refusal (`forbidden`, contracts/entitlement/v1/
// errors.json); an archived acting node is refused by the host before it signs (the acting-node
// assertion, ./acting-node.js). Roles and peer superset rules are the API's and are not re-modelled
// here: the double holds the node bound, the part a function's tests can get wrong.
//
// WORKSPACES (ADR-292 decision 3). `workspaces.create` acts for an END USER: without a signed-in session
// the host refuses it `capability.forbidden`; the product's `[authenticate.workspaces]` is
// `world.org.workspaces({ parent })`, absent → `workspaces_undeclared`. It creates one node strictly below
// `parent` and a membership for the end user homed there.
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";
import { atOrBelow } from "./authz.js";
import { validOrgPath } from "./acting-node.js";

/** The WIT interfaces of the tree capabilities (contracts/capability/v1/world.wit). */
export const TREE_INTERFACES = ["org-nodes", "members", "profiles", "groups", "denies", "workspaces"];

/**
 * The httperr codes the org-tree API answers with (control-plane/internal/api/orgtree.go orgTreeCodes,
 * contracts/entitlement/v1/errors.json) that the double raises — its declared mirror of that table — plus
 * `address_blocked`, which the platform answers workspaces.create for a blocked end user (ADR-254 decision 6,
 * ADR-292) and the double cannot judge (its sessions carry no address): a test injects it (world.faults).
 * Each is held to the published table by test/org_answers.test.mjs.
 */
export const ORG_HTTPERR_CODES = ["bad_request", "forbidden", "not_found", "conflict", "org_node_not_empty", "address_blocked", "workspaces_undeclared", "membership_home_nested", "org_node_name_invalid"];

const refuse = (code, message, details = {}) => {
  throw new CapabilityFailure(code, message, details);
};
const parse = (json) => {
  try {
    const v = JSON.parse(json);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {
    // fall through
  }
  return refuse("bad_request", "the body is not a JSON object");
};
const strictlyBelow = (n, a) => n !== a && atOrBelow(n, a);

// THE MEMBER ANSWERS (contracts/capability/v1/capabilities.json `answer` of members.invite, members.list and
// members.memberships; held by test/org_answers.test.mjs). The capability gateway and the functions host relay
// the org-tree API's body unchanged, so these are its encoders' shapes:
//   answerOf — orgtree.Member, members.invite's 201: the membership, the request's roles and scopes (a profile
//              is a grant at the home, never roles), and its state: active, or pending with its expires_at (an
//              invitation of a human the tenant already holds — see invite).
//   viewOf   — orgtree.MemberView, each listed membership (active ones only — a pending membership is never
//              listed): its address, `invited` until its human verifies the address (the double's humans never
//              do), and origin `invite`.
const answerOf = (m) => ({
  membership_id: m.membership_id, user_id: m.user_id, org_path: m.org_path, roles: [...m.roles], scopes: [...m.scopes], state: m.state,
  ...(m.state === "pending" ? { expires_at: new Date(m.expiresAtMs).toISOString() } : {}),
});
const viewOf = (m) => ({
  membership_id: m.membership_id, user_id: m.user_id, email: m.email, org_path: m.org_path,
  roles: [...m.roles], scopes: [...m.scopes], state: "invited", origin: "invite",
});

/** What the platform records of a node the test placed directly: created before the test, by the platform. */
const NODE_ORIGIN = Object.freeze({ created_by: "platform", created_at: new Date(0).toISOString() });

/** The creator of record of a node a function creates: its end user, else the function's runtime identity. */
const creator = (w) => w.principal.session()?.sub ?? "function";

/**
 * A node's display name as the platform stores it (#785): `raw` trimmed, then held to the contract's
 * org_node_name (skeleton-v1.json $defs, projected as w.contract.orgNodeName) — org_node_name_invalid otherwise.
 */
function nodeName(w, raw) {
  const g = w.contract.orgNodeName;
  const name = typeof raw === "string" ? raw.trim() : raw;
  const length = typeof name === "string" ? [...name].length : -1;
  if (typeof name !== "string" || length < g.minLength || length > g.maxLength || !new RegExp(g.pattern, "u").test(name)) {
    refuse("org_node_name_invalid", `${JSON.stringify(raw)} is not an org node name: 1 to ${g.maxLength} characters, no control character`);
  }
  return name;
}

export function createOrgState(w) {
  let declared = new Set();
  let workspaces = null;
  // membership_id → {membership_id, user_id, email, org_path, roles, scopes, grants, state, expiresAtMs}: the
  // double's record, active or pending. A function never sees it: it sees answerOf / viewOf, the platform's shapes.
  const members = new Map();
  const blocks = new Set();
  const profiles = new Map(); // `${node}|${name}` → {org_path, name, ...}
  const groups = new Map(); // `${node}|${name}` → {org_path, name, members: [{membership_id, user_id}]}
  const denies = new Map(); // id → {id, org_path, ...}
  // org_path → {display_name?, created_by, created_at}: what the platform records of a node the double
  // created (nodes.create, workspaces.create). A node a test placed directly (the acting node, a declared
  // parent) was created by the platform before the test began: NODE_ORIGIN.
  const nodeRows = new Map();

  const vocabulary = () =>
    new Set(Object.entries(w.contract.capabilityOf).filter(([k]) => TREE_INTERFACES.includes(k.split(".")[0])).map(([, v]) => v));

  /** The declaration gate, then the acting node the API judges with (the host signs for it first). */
  const acting = (op) => {
    if (!declared.has(op)) refuse("capability.forbidden", `${op} is not declared in this function's [org] operations (function.toml)`, { operation: op });
    w.actingNode.hostAssertion();
    return w.actingNode.current();
  };
  const node = (p) => {
    if (!validOrgPath(p)) refuse("bad_request", `'${String(p)}' is not an org node`);
    return p;
  };
  const placeAt = (op, p) => {
    const a = acting(op);
    if (!atOrBelow(node(p), a)) refuse("forbidden", `${p} is not at or below the acting node ${a}`);
    return p;
  };
  const lifecycleAt = (op, p) => {
    const a = acting(op);
    if (!strictlyBelow(node(p), a)) refuse("forbidden", `${p} is not strictly below the acting node ${a}`);
    return p;
  };
  const statusOf = (p) => w.projection.view().node(p)?.status;
  const active = () => [...members.values()].filter((m) => m.state === "active");
  const nests = (a, b) => a !== b && (atOrBelow(a, b) || atOrBelow(b, a));
  const existing = (p) => {
    if (statusOf(p) === undefined || p === "/") refuse("not_found", `no node ${p}`);
    return p;
  };

  const state = {
    /** The function's function.toml `[org] operations`. */
    declare(ops) {
      if (!Array.isArray(ops)) throw new DoubleMisuseError("org.declare takes the list of [org] operations");
      const vocab = vocabulary();
      for (const op of ops) if (!vocab.has(op)) throw new DoubleMisuseError(`org.declare: '${String(op)}' is not a tree operation (on the platform aircloud check refuses it: org.operation_unknown)`);
      declared = new Set(ops);
    },
    /** The product's `[authenticate.workspaces]` ({ parent }), or null for none. */
    workspaces(decl) {
      if (decl !== null && (typeof decl !== "object" || !validOrgPath(decl.parent) || decl.parent === "/")) {
        throw new DoubleMisuseError("org.workspaces takes { parent } — a node strictly below '/' — or null");
      }
      workspaces = decl;
      if (decl) w.projection.ensure(decl.parent);
    },
    // ── org-nodes ─────────────────────────────────────────────────────────────────────
    listNodes() {
      const a = acting("nodes.list");
      const nodes = w.projection.view().nodes().filter(([p]) => strictlyBelow(p, a)).map(([p, n]) => {
        const { display_name, created_by, created_at } = nodeRows.get(p) ?? NODE_ORIGIN;
        return { org_path: p, ...(display_name ? { display_name } : {}), status: n.status, created_by, created_at };
      });
      // The platform's answer names the acting node the nodes are strictly below (#384, 2026-10-29), and that
      // node's display name when it has one (#785).
      const atName = nodeRows.get(a)?.display_name;
      return { at: a, ...(atName ? { at_display_name: atName } : {}), nodes };
    },
    createNode(json) {
      const spec = parse(json);
      const p = lifecycleAt("nodes.create", spec.org_path);
      const display_name = spec.display_name === undefined ? undefined : nodeName(w, spec.display_name);
      if (statusOf(p) !== undefined) refuse("conflict", `the node ${p} exists`);
      w.projection.node(p);
      nodeRows.set(p, { display_name, created_by: creator(w), created_at: w.clock.now().toISOString() });
      return { org_path: p, ...(display_name ? { display_name } : {}) };
    },
    setStatus(op, p, status) {
      existing(lifecycleAt(op, p));
      w.projection.node(p, { status, denies: w.projection.view().node(p).denies });
    },
    deleteNode(p) {
      existing(lifecycleAt("nodes.delete", p));
      if (statusOf(p) !== "archived") refuse("org_node_not_empty", `the node ${p} is not archived`);
      w.projection.remove(p);
    },
    // ── members ───────────────────────────────────────────────────────────────────────
    // A member is addressed by its MEMBERSHIP (ADR-293 decision 2: the platform's /org-members/{id} is a
    // membership id, a user holding several); members.memberships alone is keyed by the user.
    listMembers(under) {
      const a = acting("members.list");
      const at = under === undefined ? a : node(under);
      if (!atOrBelow(at, a)) refuse("forbidden", `${at} is not at or below the acting node ${a}`);
      return { members: active().filter((m) => atOrBelow(m.org_path, at)).map(viewOf) };
    },
    invite(json) {
      const spec = parse(json);
      placeAt("members.invite", spec.org_path);
      if (typeof spec.email !== "string" || !spec.email.includes("@")) refuse("bad_request", "invalid email");
      // A block is NOT judged here (ADR-254 decision 6): it refuses self-registration and workspace creation,
      // never an invite, and the invite leaves it in place — only unblock ends it.
      // The membership's own roles and scopes are the request's; a profile is conferred by a grant at the home
      // (orgtree.CreateMember), never folded into roles.
      const m = {
        membership_id: w.newId(), user_id: null, email: spec.email, org_path: spec.org_path,
        roles: [...(spec.roles ?? [])], scopes: [...(spec.scopes ?? [])], grants: [], state: "active", expiresAtMs: null,
      };
      // THE ADDRESS'S HUMAN. A human the tenant holds — one with any membership row — is invited by a PENDING
      // membership when it holds an ACTIVE one (orgtree.invitePending, operator decision D44), and is someone
      // else's to the invite otherwise (ErrAddressHeld → conflict). The pending home is judged as every home
      // (migration 000043): a home nesting with one of the human's homes, active or pending, is
      // membership_home_nested (the guard trigger, before the home key); an equal home is the home key's
      // conflict, unless the row there is an expired invitation, which the invite replaces. An expired
      // invitation elsewhere still counts until the platform's sweep removes it; the double has no sweep. Its
      // lifetime is the generated projection's invitationExpirySeconds (contracts/auth/v1/account-lifecycle.json).
      const held = [...members.values()].filter((x) => x.email === spec.email);
      if (held.length > 0) {
        if (!held.some((x) => x.state === "active")) refuse("conflict", `${spec.email} is held by a human with no active membership in the tenant`);
        const now = w.clock.nowMs();
        const stale = held.find((x) => x.org_path === spec.org_path && x.state === "pending" && x.expiresAtMs <= now);
        const homes = held.filter((x) => x !== stale);
        if (homes.some((x) => nests(x.org_path, spec.org_path))) refuse("membership_home_nested", `${spec.org_path} nests with another home of ${spec.email}`);
        if (homes.some((x) => x.org_path === spec.org_path)) refuse("conflict", `${spec.email} already holds a membership at ${spec.org_path}`);
        if (stale) members.delete(stale.membership_id);
        const ttl = w.contract.invitationExpirySeconds;
        if (!Number.isInteger(ttl) || ttl <= 0) throw new DoubleMisuseError("the generated contract projection carries no invitationExpirySeconds — regenerate it (scripts/dev/gen-aircloud-testing.sh)");
        Object.assign(m, { user_id: held[0].user_id, state: "pending", expiresAtMs: now + ttl * 1000 });
      } else {
        m.user_id = w.newId();
      }
      if (spec.profile != null) m.grants.push({ id: w.newId(), org_path: spec.org_path, profile: spec.profile });
      members.set(m.membership_id, m);
      return answerOf(m);
    },
    member(op, membershipId) {
      const a = acting(op);
      // Only an ACTIVE membership is addressable (orgtree lockMember): a pending one is not_found.
      const m = members.get(membershipId);
      if (!m || m.state !== "active" || !atOrBelow(m.org_path, a)) refuse("not_found", `no membership ${membershipId} at or below ${a}`);
      return m;
    },
    updateMember(membershipId, json) {
      const m = state.member("members.update", membershipId);
      const p = parse(json);
      if (p.org_path !== undefined) placeAt("members.update", p.org_path);
      for (const k of ["org_path", "roles", "scopes"]) if (p[k] !== undefined && p[k] !== null) m[k] = Array.isArray(p[k]) ? [...p[k]] : p[k];
    },
    removeMember(membershipId, block) {
      const m = state.member("members.remove", membershipId);
      members.delete(membershipId);
      for (const g of groups.values()) g.members = g.members.filter((x) => x.membership_id !== membershipId);
      if (block) blocks.add(m.email);
    },
    unblock(email) {
      acting("members.unblock");
      if (!blocks.delete(email)) refuse("not_found", `no block on ${email}`);
    },
    grant(membershipId, json) {
      const m = state.member("members.grant", membershipId);
      const g = parse(json);
      placeAt("members.grant", g.org_path ?? m.org_path);
      const grant = { id: w.newId(), ...g };
      m.grants.push(grant);
      return grant;
    },
    revokeGrant(membershipId, grantId) {
      const m = state.member("members.revoke_grant", membershipId);
      const before = m.grants.length;
      m.grants = m.grants.filter((g) => g.id !== grantId);
      if (m.grants.length === before) refuse("not_found", `${grantId} is not a grant of the member`);
    },
    memberships(userId) {
      const a = acting("members.memberships");
      return { memberships: active().filter((m) => m.user_id === userId && atOrBelow(m.org_path, a)).map(viewOf) };
    },
    // ── profiles ──────────────────────────────────────────────────────────────────────
    listProfiles(at) {
      const a = acting("profiles.list");
      const n = at === undefined ? a : node(at);
      return { profiles: [...profiles.values()].filter((p) => atOrBelow(n, p.org_path) || atOrBelow(p.org_path, n)) };
    },
    putProfile(n, name, json) {
      placeAt("profiles.put", n);
      const p = { ...parse(json), org_path: n, name };
      profiles.set(`${n}|${name}`, p);
      return p;
    },
    removeProfile(n, name) {
      placeAt("profiles.remove", n);
      if (!profiles.delete(`${n}|${name}`)) refuse("not_found", `no profile ${name} at ${n}`);
    },
    // ── groups ────────────────────────────────────────────────────────────────────────
    listGroups() {
      const a = acting("groups.list");
      return { groups: [...groups.values()].filter((g) => atOrBelow(g.org_path, a)) };
    },
    putGroup(json) {
      const g = parse(json);
      placeAt("groups.put", g.org_path);
      if (groups.has(`${g.org_path}|${g.name}`)) refuse("conflict", `the group ${g.name} exists at ${g.org_path}`);
      const group = { ...g, members: [] };
      groups.set(`${g.org_path}|${g.name}`, group);
      return group;
    },
    group(op, n, name) {
      placeAt(op, n);
      const g = groups.get(`${n}|${name}`);
      if (!g) refuse("not_found", `no group ${name} at ${n}`);
      return g;
    },
    removeGroup(n, name) {
      state.group("groups.remove", n, name);
      groups.delete(`${n}|${name}`);
    },
    addGroupMember(n, name, json) {
      const g = state.group("groups.add_member", n, name);
      // The platform's body is {membership_id} (POST …/org-groups/members): a group holds memberships.
      const { membership_id } = parse(json);
      const m = members.get(membership_id);
      if (!m || m.state !== "active") refuse("not_found", `no membership ${membership_id}`);
      if (g.members.some((x) => x.membership_id === membership_id)) refuse("conflict", `${membership_id} is in the group`);
      g.members.push({ membership_id, user_id: m.user_id, org_path: m.org_path });
    },
    removeGroupMember(n, name, membershipId) {
      const g = state.group("groups.remove_member", n, name);
      const before = g.members.length;
      g.members = g.members.filter((m) => m.membership_id !== membershipId);
      if (g.members.length === before) refuse("not_found", `no group membership ${membershipId}`);
    },
    // ── denies ────────────────────────────────────────────────────────────────────────
    listDenies() {
      const a = acting("denies.list");
      return { denies: [...denies.values()].filter((d) => atOrBelow(d.org_path, a)) };
    },
    putDeny(json) {
      const d = parse(json);
      lifecycleAt("denies.put", d.org_path);
      const deny = { id: w.newId(), ...d };
      denies.set(deny.id, deny);
      w.projection.deny({ org_path: d.org_path, roles: d.roles ?? [], ops: d.ops ?? [], entity: d.entity ?? null });
      return deny;
    },
    removeDeny(id) {
      const a = acting("denies.remove");
      const d = denies.get(id);
      if (!d || !strictlyBelow(d.org_path, a)) refuse("not_found", `no deny ${id} strictly below ${a}`);
      denies.delete(id);
    },
    // ── workspaces ────────────────────────────────────────────────────────────────────
    createWorkspace(json) {
      const op = "workspaces.create";
      if (!declared.has(op)) refuse("capability.forbidden", `${op} is not declared in this function's [org] operations (function.toml)`, { operation: op });
      const session = w.principal.session();
      if (!session) refuse("capability.forbidden", `${op} acts for an end user: this invocation serves none`, { operation: op });
      w.actingNode.hostAssertion();
      if (!workspaces) refuse("workspaces_undeclared", "the product declares no [authenticate.workspaces]");
      const { display_name: given } = parse(json);
      if (typeof given !== "string" || given.trim() === "") refuse("bad_request", "display_name is required");
      // The display name is the new node's name for people (#785), held to org_node_name as nodes.create holds it.
      const display_name = nodeName(w, given);
      const base = display_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workspace";
      let slug = base;
      for (let i = 2; statusOf(`${workspaces.parent}/${slug}`) !== undefined; i++) slug = `${base}-${i}`;
      const orgPath = `${workspaces.parent}/${slug}`;
      w.projection.node(orgPath);
      nodeRows.set(orgPath, { display_name, created_by: session.sub, created_at: w.clock.now().toISOString() });
      return { org_path: orgPath, display_name, membership_id: w.newId() };
    },
  };
  return state;
}
