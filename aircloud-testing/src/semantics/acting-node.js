// @aircloudhq/testing — the acting node of an invocation, the host-signed assertion every Flex call
// carries, and the function's declared elevated aggregates (functions/src/acting_node.rs,
// caps_acting_node.rs, caps_principal.rs `claims` and release_model.rs; #384 ADR-295 decisions 1 to 3
// and 8).
//
// On the platform the functions-host resolves the ENTRY node before the guest runs — a session's
// selected membership's home, a public route's or a trigger's declared `org_path`, a direct caller's
// node — and the guest may only narrow at or below it. Under node:test `invoke(entry, request)` resolves
// it the same way from the release's entry model (./entries.js, #384 D66), once per invocation: the
// invocation's frame (./invocation.js) holds its entry and its narrowing, which end with it. A capability
// called directly, outside `invoke`, reads the test's declaration instead: `world.actingNode.enter("/acme")`
// (a signed-in principal's membership home is the entry when it serves a session). There is no default
// node: an undeclared entry is what the host refuses with functions.org_path_undeclared before the guest
// runs — never acting at '/' — so `current()` and `narrow` with neither raise a DoubleMisuseError naming
// that refusal (a guest never observes it live).
//
// THE ASSERTION (`hostAssertion`). The host signs one per Flex call (contracts/flex/v1/
// end-user-assertion.json): kind `end_user` for a session (its sub and selected membership; the acting
// org_path only when the guest narrowed), kind `node` for a declared entry (the acting org_path), kind
// `elevation` — the base kind's claims plus the declaration — for one declared elevated aggregate call.
// Every kind carries the entry node, never a role; the host refuses to sign for an archived or unknown
// node (capability.org_node_archived, naming it). The double's Flex verifies it as Flex does (./acting.js).
//
// THE ELEVATION. `flex-query.aggregate-elevated` is checked against the function's `[[elevate]]`
// declarations as the host checks it (capability.forbidden naming the role and value, before Flex), then Flex
// runs the one aggregate under the elevation assertion. Inside `invoke` they are the INVOKED function's own,
// read from the release's entry model (./entries.js — what function.toml declares, as the release model
// carries it to the host); a test cannot add to them. Outside `invoke` — a capability binding called directly,
// with no function — `world.actingNode.declareElevate([{entity, ops, filter, group_by, fields, scope}])` stands
// for the declarations, and it never reaches an invocation.
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";
import { atOrBelow, AuthzRefusal, nodeChain } from "./authz.js";
import { currentFrame } from "./invocation.js";

/** The cause the double signs into every assertion (#384 D78): it records no events, so one fixed id. */
const DOUBLE_CAUSE = "00000000-0000-4000-8000-0000000000ca";

/** contracts/auth/v1/org-path.json `grammar` (segment_regex, max_depth, max_length). */
const SEGMENT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MAX_DEPTH = 8;
const MAX_LENGTH = 512;

/** Whether `p` is a node of the org-path grammar. */
export function validOrgPath(p) {
  if (p === "/") return true;
  if (typeof p !== "string" || !p.startsWith("/") || p.length > MAX_LENGTH || p.endsWith("/")) return false;
  const segs = p.slice(1).split("/");
  return segs.length <= MAX_DEPTH && segs.every((s) => SEGMENT.test(s));
}

/** == functions/src/release_model.rs RECORD_ID_FIELD. */
const RECORD_ID_FIELD = "id";

function filterFields(f, out) {
  if (f === null || typeof f !== "object" || Array.isArray(f)) throw elevationShape("a filter node is not an object");
  const list = f.and ?? f.or;
  if (list !== undefined) {
    if (!Array.isArray(list)) throw elevationShape("and/or is not an array");
    for (const c of list) filterFields(c, out);
    return;
  }
  if (f.not !== undefined) return filterFields(f.not, out);
  if (typeof f.field !== "string") throw elevationShape("a filter leaf names no field");
  out.push(f.field);
}

function elevationShape(value) {
  return { role: "shape", value };
}

/**
 * The elevation check (functions/src/release_model.rs `check_elevated` at the host, and Flex's
 * `elevation_declaration` over the assertion's one declaration): the declaration the call stays inside,
 * or `{role, value}` of the first thing outside it. `identifiers` are the fields refused in any role —
 * the record id and the entity's owner field.
 */
export function checkElevated(decls, entity, body, identifiers) {
  const decl = decls.find((d) => d.entity === entity);
  if (!decl) return { refusal: { role: "entity", value: entity } };
  for (const f of [...(decl.filter ?? []), ...(decl.group_by ?? []), ...(decl.fields ?? [])]) {
    if (identifiers.includes(f)) return { refusal: { role: "identifier", value: f } };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { refusal: elevationShape("the query is not an object") };
  const extra = Object.keys(body).find((k) => k !== "aggregate" && k !== "filter");
  if (extra) return { refusal: elevationShape(`an elevated aggregate carries no "${extra}"`) };
  const agg = body.aggregate;
  if (agg === null || typeof agg !== "object") return { refusal: elevationShape("the query carries no aggregate") };
  if (!(decl.ops ?? []).includes(agg.fn)) return { refusal: { role: "op", value: String(agg.fn) } };
  const named = [];
  if (agg.field !== undefined) named.push(["field", agg.field]);
  if (agg.group_by !== undefined) named.push(["group_by", agg.group_by]);
  if (body.filter !== undefined) {
    const leaves = [];
    try {
      filterFields(body.filter, leaves);
    } catch (r) {
      return { refusal: r };
    }
    for (const l of leaves) named.push(["filter", l]);
  }
  for (const [role, value] of named) {
    if (identifiers.includes(value)) return { refusal: { role: "identifier", value } };
    const declared = role === "field" ? decl.fields : role === "group_by" ? decl.group_by : decl.filter;
    if (!(declared ?? []).includes(value)) return { refusal: { role, value } };
  }
  return { decl };
}

export function createActingNodeState(w) {
  let entry = null;
  let acting = null;
  let elevate = [];
  /**
   * The entry node: the running invocation's (what its entry resolved to); outside one, the session's
   * membership home, else the declared entry, else null (undeclared).
   */
  const entryNode = () => {
    const f = currentFrame();
    return f ? f.entry : w.principal.session()?.home ?? entry;
  };
  /** The node the next call acts at: the narrowing of the running invocation, or of the test. */
  const actingNode = () => {
    const f = currentFrame();
    return f ? f.acting : acting;
  };
  const declaredEntry = () => {
    const e = entryNode();
    if (e !== null) return e;
    throw new DoubleMisuseError(
      "acting-node: no entry node — on the platform this invocation is refused with functions.org_path_undeclared before it runs (the host never acts at '/' by default); declare it with world.actingNode.enter(orgPath), or sign an end user in",
    );
  };
  const state = {
    /** The invocation's entry node (what its route, trigger or caller resolved to); it exists in the projection. */
    enter(orgPath) {
      if (!validOrgPath(orgPath)) throw new DoubleMisuseError(`actingNode.enter: '${String(orgPath)}' is not an org node`);
      w.projection.ensure(orgPath);
      entry = orgPath;
      acting = null;
    },
    /** The `[[elevate]]` declarations a binding called OUTSIDE `invoke` checks against (an invocation reads its function's). */
    declareElevate(decls) {
      if (!Array.isArray(decls)) throw new DoubleMisuseError("actingNode.declareElevate takes an array of declarations");
      elevate = decls.map((d) => ({ ...d }));
    },
    /** The declarations the next aggregate-elevated call stays inside: the invoked function's, else the test's. */
    elevations() {
      const f = currentFrame();
      return f ? f.elevate ?? [] : elevate;
    },
    /** Back to an undeclared entry and no elevation (world.reset). */
    reset() {
      entry = null;
      acting = null;
      elevate = [];
    },
    /**
     * The claim set the host signs for the next Flex call (after its signature and bindings — what Flex
     * parses), or null for an invocation with neither a session nor a declared entry. `elevation` (a
     * declaration) makes it the one elevated call's.
     */
    hostAssertion(elevation = null) {
      const session = w.principal.session();
      const e = entryNode();
      if (e === null) return null;
      const now = actingNode() ?? e;
      // The host never signs for an archived node, or one with no key (caps_flex.rs acting_assertion).
      try {
        nodeChain(w.projection.view(), now);
      } catch (x) {
        if (!(x instanceof AuthzRefusal)) throw x;
        throw new CapabilityFailure("capability.org_node_archived", `the node ${now} is archived or cannot be proven active: nothing acts there`, { org_path: now });
      }
      // #384 D78/D82: every kind carries the invocation's cause and the surface its entry serves (the
      // test's world.flex.surface). The double records no events, so its cause is one fixed id.
      const surface = w.flex.surface;
      if (!w.contract.hostAssertion.surfaces.includes(surface)) {
        throw new DoubleMisuseError(`flex.surface '${String(surface)}' is not a surface (${w.contract.hostAssertion.surfaces.join(", ")})`);
      }
      const claims = { entry_org_path: e, causation_id: DOUBLE_CAUSE, surface };
      if (session) {
        Object.assign(claims, { kind: "end_user", sub: session.sub, membership_id: session.membershipId });
        if (session.act !== undefined) claims.act = JSON.parse(session.act);
        if (now !== e) claims.org_path = now;
      } else {
        Object.assign(claims, { kind: "node", org_path: now });
      }
      if (elevation) {
        const { entity, ops, filter, group_by, fields, scope } = elevation;
        Object.assign(claims, { kind: "elevation", entity, ops, filter: filter ?? [], group_by: group_by ?? [], fields: fields ?? [], scope, function: elevation.function ?? "test" });
      }
      return claims;
    },
    // ── the WIT surface ─────────────────────────────────────────────────────────────────
    current() {
      return actingNode() ?? declaredEntry();
    },
    narrow(path) {
      const e = declaredEntry();
      if (!validOrgPath(path)) {
        throw new CapabilityFailure("capability.validation", `${JSON.stringify(path)} is not an org node`, { org_path: path });
      }
      if (!atOrBelow(path, e)) {
        throw new CapabilityFailure(
          "capability.forbidden",
          `${path} is not at or below this invocation's entry node ${e}: narrowing never widens`,
          { org_path: path, entry_org_path: e },
        );
      }
      const f = currentFrame();
      if (f) f.acting = path;
      else acting = path;
    },
  };
  return state;
}

export { RECORD_ID_FIELD };
