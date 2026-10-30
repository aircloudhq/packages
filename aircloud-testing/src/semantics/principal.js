// @aircloudhq/testing — the end-user principal interface (functions/src/caps_principal.rs; #632
// ADR-241 decision 4, plan W15.4/W15.7; #384 ADR-293 decisions 7 and 9).
//
// On the platform the functions-host route trigger verifies the web-origin's principal assertion — the end
// user and the membership its session selected — and resolves it in the tenant's authority projection: the
// membership's home is the invocation's entry node and the roles the projection gives it there are the
// principal's (never an asserted role). Every other invocation has none. Under node:test the test decides:
//
//   world.principal.signIn({ sub, orgPath, roles, grants })  one membership homed at `orgPath` (default `/`)
//                                                             holding `roles` there and each grant — a profile
//                                                             held at a node at or below the home until it
//                                                             expires ({node, profile, roles, expires?},
//                                                             ./test-principal.js) — test/principals.toml's
//                                                             shape
//   world.principal.signIn({ sub, memberships, membership }) the end user's memberships in the projection's
//                                                             shape ({id, home, home_roles, scopes, grants:
//                                                             [{org_path, roles, exp, via_group}], denies})
//                                                             and the one the session selected (required
//                                                             when it holds several)
//
// Either places the end user's projection key (world.projection) and makes the next invocations through a
// route the session's; `world.reset()` (or `signOut()`) returns to none. An invocation through an event, a
// cron or a direct invoke serves no end user whoever is signed in (./entries.js): inside it every answer
// below is the no-session one. The answers are the host's: `current()` the
// principal (its selected membership's home and the roles effective there — a selection the projection
// refuses is refused by the host before the guest runs, functions.membership_required or
// functions.org_node_archived, raised here as a DoubleMisuseError naming it), `flash()`
// the message the platform took out of the session for this request, `csrfToken()` the session's token,
// and `setFlash(text)` records the next request's flash on `world.principal.flashOut` —
// `functions.validation` outside a session or out of bounds.
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";
import {
  activeGrants,
  AuthzRefusal,
  authorityOf,
  checkPrincipal,
  effectiveAtOrBelow,
  membershipRolesAt,
  nodeChain,
  rolesAt,
  selectMembership,
} from "./authz.js";
import { validOrgPath } from "./acting-node.js";
import { testPrincipalGrants } from "./test-principal.js";
import { currentFrame } from "./invocation.js";

/** == functions/src/caps_principal.rs MAX_FLASH_BYTES (the web-origin's FLASH_MAX_BYTES). */
const MAX_FLASH_BYTES = 4096;

/**
 * A session the projection refuses is refused by the host BEFORE the guest runs (functions/src/acting_node.rs
 * `session`, ActingRefusal::Projection): no guest ever observes it, so the double raises it as the test's
 * misuse naming the code the invocation answers, never as a capability error a guest could catch.
 */
function hostRefusal(e) {
  if (!(e instanceof AuthzRefusal)) return e;
  const code = e.reason === "membership_required" ? "functions.membership_required"
    : e.reason === "unauthenticated" ? "functions.unauthenticated"
    : "functions.org_node_archived";
  return new DoubleMisuseError(`principal: on the platform this session invocation is refused with ${code} before it runs (${e.detail})`);
}

export function createPrincipalState(w) {
  let signedIn = null;
  /** The session the running invocation serves: none inside an invocation that serves no end user. */
  const live = () => {
    const f = currentFrame();
    return f && !f.session ? null : signedIn;
  };
  /** The signed-in session's selected membership in the projection (a refusal is the host's). */
  const selected = () => {
    try {
      const view = w.projection.view();
      return { view, m: selectMembership(checkPrincipal(view.principal(signedIn.sub), "end_user"), signedIn.membership) };
    } catch (e) {
      throw hostRefusal(e);
    }
  };
  /** The session's resolution in the projection: its selected membership and the roles at its home. */
  const resolve = () => {
    const { view, m } = selected();
    try {
      const roles = rolesAt(authorityOf(m, nodeChain(view, m.home), w.clock.nowMs()), m.home);
      return { membershipId: m.id, home: m.home, roles };
    } catch (e) {
      throw hostRefusal(e);
    }
  };
  const state = {
    /** The flash the guest set for the next request (null until it sets one). */
    flashOut: null,
    /** Sign an end user in: the invocations that follow serve a `session` route. */
    signIn({ sub, tenantId, orgPath, roles, grants, memberships, membership, act, flash, csrf } = {}) {
      if (typeof sub !== "string" || sub === "") throw new DoubleMisuseError("principal.signIn: sub is required");
      if (memberships !== undefined) {
        if (orgPath !== undefined || roles !== undefined || grants !== undefined) {
          throw new DoubleMisuseError("principal.signIn: give either { orgPath, roles, grants } (one membership) or { memberships, membership }, not both");
        }
        if (!Array.isArray(memberships) || memberships.length === 0) throw new DoubleMisuseError("principal.signIn: memberships is a non-empty list");
      } else if (membership !== undefined) {
        throw new DoubleMisuseError("principal.signIn: membership selects one of memberships, and none were given");
      }
      const home = orgPath ?? "/";
      if (typeof home !== "string" || !home.startsWith("/")) {
        throw new DoubleMisuseError(`principal.signIn: orgPath '${String(home)}' is not a tree path`);
      }
      const list = memberships ?? [{ id: `m-${sub}`, home, home_roles: [...(roles ?? [])], grants: testPrincipalGrants(home, grants) }];
      w.projection.endUser(sub, list);
      signedIn = {
        sub,
        membership: memberships === undefined ? list[0].id : membership ?? null,
        tenantId: tenantId ?? w.newId(),
        act: typeof act === "string" ? act : act === undefined ? undefined : JSON.stringify(act),
        flash: flash ?? undefined,
        csrf: csrf ?? `${w.newId()}${w.newId()}`.replace(/-/g, ""),
      };
    },
    /** End the session: the invocations that follow serve a public route again. */
    signOut() {
      signedIn = null;
    },
    /**
     * The session as the host resolved it — {sub, membershipId, home, roles, act} — or null on a public
     * route (the acting node and the functions-host assertion read it).
     */
    session() {
      const session = live();
      if (!session) return null;
      return { sub: session.sub, act: session.act, ...resolve() };
    },
    current() {
      const session = live();
      if (!session) return undefined;
      const { home, roles } = resolve();
      return { sub: session.sub, tenantId: session.tenantId, orgPath: home, roles, act: session.act };
    },
    flash() {
      const session = live();
      return session ? session.flash : undefined;
    },
    csrfToken() {
      const session = live();
      return session ? session.csrf : undefined;
    },
    /** The session's SELECTED membership (#384, ADR-293 decision 9), none outside a session. */
    membershipId() {
      return live() ? resolve().membershipId : undefined;
    },
    /**
     * The selected membership's effective grants (#384 D105) — its unexpired grants, a group's included,
     * each {orgPath, profile: {orgPath, name}, roles, expiresAt}; none outside a session.
     */
    grants() {
      if (!live()) return [];
      const { m } = selected();
      return activeGrants(m, w.clock.nowMs()).map((g) => {
        if (g.profile === null) {
          throw new DoubleMisuseError(`principal.grants: a grant at ${g.org_path} names no profile — every projected grant carries {org_path, name}; give one in signIn`);
        }
        return {
          orgPath: g.org_path,
          profile: { orgPath: g.profile.org_path, name: g.profile.name },
          roles: [...g.roles],
          expiresAt: g.expText ?? undefined,
        };
      });
    },
    /**
     * The roles the selected membership holds effectively at `node` (#384 D105): the projection's
     * evaluation at or below its home, none elsewhere; none outside a session. functions.validation for a
     * path that is not an org node.
     */
    rolesAt(node) {
      if (!validOrgPath(node)) {
        throw new CapabilityFailure("functions.validation", `${JSON.stringify(node)} is not an org node`, { org_path: node });
      }
      if (!live()) return [];
      const { view, m } = selected();
      return membershipRolesAt(view, m, node, w.clock.nowMs());
    },
    setFlash(message) {
      const refuse = (m) => {
        throw new CapabilityFailure("functions.validation", m, { max_bytes: MAX_FLASH_BYTES });
      };
      if (!live()) refuse("this invocation serves no end-user session");
      if (typeof message !== "string" || message === "" || Buffer.byteLength(message) > MAX_FLASH_BYTES || /\p{Cc}/u.test(message)) {
        refuse("the flash must be 1..=4096 bytes of text without control characters");
      }
      state.flashOut = message;
    },
  };
  routeGates.set(state, (roles, at) => {
    if (!signedIn) throw new DoubleMisuseError("principal: the route-role gate runs only for a signed-in session");
    if (roles.length === 0) return true;
    const held = at === undefined || at === null ? new Set(resolve().roles) : (() => {
      w.projection.ensure(at);
      const { view, m } = selected();
      return effectiveAtOrBelow(view, m, at, w.clock.nowMs());
    })();
    return roles.some((r) => held.has(r));
  });
  return state;
}

/** Each principal state's route-role gate, kept off the public `world.principal` (#384 D72). */
const routeGates = new WeakMap();

/**
 * The web-origin's route-role gate (web-origin/src/route_roles.rs `admits`; ADR-254 decision 4, ADR-292
 * decision 1) for the session signed in on `principal`: `true` when `roles` is empty, or when one of them is
 * effective for the selected membership — at its home with no `at`, at `at` or below it otherwise. invoke
 * runs it before the host is reached (./entries.js); a test observes it only as invoke's
 * session_role_required, never by asking the double, so it is not a member of the public world.principal.
 */
export function routeAdmits(principal, roles, at) {
  const gate = routeGates.get(principal);
  if (!gate) throw new Error("@aircloudhq/testing defect: routeAdmits on an object that is no principal state");
  return gate(roles, at);
}
