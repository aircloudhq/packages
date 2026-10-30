// @aircloudhq/web/org — the clients of the platform's org-tree surfaces on a product host (#384; ADR-254
// decision 10, ADR-293 decisions 1–6 and 9, ADR-292 decisions 2 and 3). The web-origin serves them under
// the reserved /_air/ directory with the signed-in end user's OWN session and relays the control-plane
// org-tree API; the API's scope check and org-tree bounds decide every answer — this client authorizes
// nothing, and every refusal rejects with the platform's ApiError (`code`, `details`).
//
//   import { memberships, members, workspaces } from '@aircloudhq/web/org';
//   const { memberships: mine, selected } = await memberships.list();   // the switcher
//   await memberships.select(mine[1].membership_id);                     // act through another, no re-login
//   await members.invite({ email, orgPath: '/org/acme', roles: [], profile: { orgPath: '/', name: 'sales' } });
//   const ws = await workspaces.create({ displayName: 'Acme' });         // {org_path, membership_id, selected}
//   const { at, nodes, names } = await orgNodes.homes();                 // where an invite may home: at first
//
// A node is the API's own `node` query parameter (with `name` for a profile or a group, run decision D73),
// never a path segment; a node a request CREATES rides in its body. Arguments are camelCase; answers are the
// API's documents as it wrote them (snake_case). Every function takes the api() options last (`fetch`,
// `locale`, `headers`).
import { api } from './api.js';

/** The membership switcher: GET lists the end user's own memberships, POST selects the acting one. */
export const MEMBERSHIPS_PATH = '/_air/memberships';
/** The members surface: the org-tree API relayed with the session's own token and selection. */
export const MEMBERS_PATH = '/_air/members';
/** Workspace signup: POST creates a workspace for the session's end user and selects it. */
export const WORKSPACES_PATH = '/_air/workspaces';

/**
 * The published refusal of a request needing a membership the session has not validly selected (run
 * decision D76; details: reason, memberships) — send the end user to the switcher.
 */
export const SESSION_MEMBERSHIP_REQUIRED = 'session_membership_required';
/** The published refusal of a route whose roles the selected membership lacks at the route's node. */
export const SESSION_ROLE_REQUIRED = 'session_role_required';

/** path?query, the query from the defined entries of `params` (an empty query adds nothing). */
function at(path, params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

const seg = (s) => encodeURIComponent(String(s));

/** A profile reference as the API writes it: {org_path, name}. */
const ref = (profile) => ({ org_path: profile.orgPath, name: profile.name });

/** The defined members of `o` (an absent key stays absent: the API reads it as unchanged or none). */
function defined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** A grant's body: the node it is placed at, the profile by reference, an optional expiry. */
const grantBody = ({ orgPath, profile, expiresAt }) => defined({ org_path: orgPath, profile: ref(profile), expires_at: expiresAt });

/** A group's address: ?node=&name=. */
const groupAt = (path, group) => at(path, { node: group.node, name: group.name });

export const memberships = {
  /** The end user's own memberships and the session's selection: {memberships: [...], selected: id|null}. */
  list: (options) => api('GET', MEMBERSHIPS_PATH, undefined, options),
  /** Make `membershipId` the session's acting membership (validated against the authority projection). */
  select: (membershipId, options) => api('POST', MEMBERSHIPS_PATH, { membership_id: membershipId }, options),
  /**
   * One of the end user's own memberships' effective authority (#384 D105), read from the authority
   * projection: {membership_id, home, node, roles, grants: [{org_path, profile, roles, expires_at}]} —
   * `roles` the ones it holds at `node` (its home when absent; none above or beside the home).
   */
  roles: (membershipId, { node } = {}, options) =>
    api('GET', at(`${MEMBERSHIPS_PATH}/${seg(membershipId)}/roles`, { node }), undefined, options),
};

export const members = {
  /** The members at or below `node` (the caller's node when absent): [{membership_id, user_id, …}]. */
  list: ({ node } = {}, options) => api('GET', at(MEMBERS_PATH, { node }), undefined, options).then((b) => b.members),
  /**
   * Invite a member at `orgPath` with `roles`, the delegable `scopes` the caller holds, and optionally a
   * `profile` by reference ({orgPath, name}) as its non-expiring home grant. Resolves to the membership.
   */
  invite: ({ email, orgPath, roles = [], scopes = [], profile }, options) =>
    api('POST', MEMBERS_PATH, defined({ email, org_path: orgPath, roles, scopes, profile: profile && ref(profile) }), options),
  /** Change a membership's home, roles or scopes — only the keys the patch names. */
  update: (membershipId, { orgPath, roles, scopes } = {}, options) =>
    api('PATCH', `${MEMBERS_PATH}/${seg(membershipId)}`, defined({ org_path: orgPath, roles, scopes }), options),
  /** Remove a membership; `block` also blocks its address. */
  remove: (membershipId, { block } = {}, options) =>
    api('DELETE', at(`${MEMBERS_PATH}/${seg(membershipId)}`, { block: block ? 'true' : undefined }), undefined, options),
  /** A membership's grants at or below the caller. */
  grants: (membershipId, options) => api('GET', `${MEMBERS_PATH}/${seg(membershipId)}/grants`, undefined, options).then((b) => b.grants),
  /** Grant a membership a profile ({orgPath, name}) at `orgPath`, optionally until `expiresAt`. */
  grant: (membershipId, grant, options) => api('POST', `${MEMBERS_PATH}/${seg(membershipId)}/grants`, grantBody(grant), options),
  /** Revoke one grant of a membership. */
  revokeGrant: (membershipId, grantId, options) =>
    api('DELETE', `${MEMBERS_PATH}/${seg(membershipId)}/grants/${seg(grantId)}`, undefined, options),
  /** The blocked addresses at or below the caller. */
  blocks: (options) => api('GET', `${MEMBERS_PATH}/blocks`, undefined, options).then((b) => b.blocks),
  /** Lift the block on `email`. */
  unblock: (email, options) => api('DELETE', `${MEMBERS_PATH}/blocks/${encodeURI(email)}`, undefined, options),
  /** One person's memberships the caller may see, by its user id. */
  ofUser: (userId, options) => api('GET', `${MEMBERS_PATH}/users/${seg(userId)}/memberships`, undefined, options).then((b) => b.memberships),
};

export const profiles = {
  /** The profiles visible at `node` (the caller's home when absent). */
  list: ({ node } = {}, options) => api('GET', at(`${MEMBERS_PATH}/profiles`, { node }), undefined, options).then((b) => b.profiles),
  /** Create or replace the runtime profile `name` defined at `node`, conferring `roles`. */
  put: ({ node, name, roles }, options) => api('PUT', at(`${MEMBERS_PATH}/profiles`, { node, name }), { roles }, options),
  /** Remove the profile `name` defined at `node`. */
  remove: ({ node, name }, options) => api('DELETE', at(`${MEMBERS_PATH}/profiles`, { node, name }), undefined, options),
};

export const groups = {
  /** The groups at or below the caller. */
  list: (options) => api('GET', `${MEMBERS_PATH}/groups`, undefined, options).then((b) => b.groups),
  /** Define the group `name` at `node`. */
  create: ({ node, name }, options) => api('POST', `${MEMBERS_PATH}/groups`, { org_path: node, name }, options),
  /** Remove a group (refused while it has members or grants). */
  remove: (group, options) => api('DELETE', groupAt(`${MEMBERS_PATH}/groups`, group), undefined, options),
  /** A group's memberships. */
  members: (group, options) => api('GET', groupAt(`${MEMBERS_PATH}/groups/members`, group), undefined, options).then((b) => b.members),
  /** Add a membership to a group (a confer of every role its grants carry). */
  addMember: (group, membershipId, options) =>
    api('POST', groupAt(`${MEMBERS_PATH}/groups/members`, group), { membership_id: membershipId }, options),
  /** Remove a membership from a group. */
  removeMember: (group, membershipId, options) =>
    api('DELETE', groupAt(`${MEMBERS_PATH}/groups/members/${seg(membershipId)}`, group), undefined, options),
  /** A group's grants. */
  grants: (group, options) => api('GET', groupAt(`${MEMBERS_PATH}/groups/grants`, group), undefined, options).then((b) => b.grants),
  /** Grant a group a profile at a node. */
  grant: (group, grant, options) => api('POST', groupAt(`${MEMBERS_PATH}/groups/grants`, group), grantBody(grant), options),
  /** Revoke one grant of a group. */
  revokeGrant: (group, grantId, options) =>
    api('DELETE', groupAt(`${MEMBERS_PATH}/groups/grants/${seg(grantId)}`, group), undefined, options),
};

export const denies = {
  /** The denies below the caller. */
  list: (options) => api('GET', `${MEMBERS_PATH}/denies`, undefined, options).then((b) => b.denies),
  /** Author a deny at `orgPath` over `roles` and `ops`, optionally of one `entity`. */
  create: ({ orgPath, roles = [], ops = [], entity }, options) =>
    api('POST', `${MEMBERS_PATH}/denies`, defined({ org_path: orgPath, roles, ops, entity }), options),
  /** Lift a deny. */
  remove: (denyId, options) => api('DELETE', `${MEMBERS_PATH}/denies/${seg(denyId)}`, undefined, options),
};

/** `path` is `node` or below it (`node` is never '/' here: it is a listed node, strictly below the caller). */
const atOrBelow = (path, node) => path === node || path.startsWith(`${node}/`);

export const orgNodes = {
  /** The nodes strictly below the caller. */
  list: (options) => api('GET', `${MEMBERS_PATH}/nodes`, undefined, options).then((b) => b.nodes),
  /**
   * The nodes the caller may home a member at (ADR-293 decision 6: at or below the caller), from one node
   * listing: {at, nodes: [org_path, …], names: {org_path: display_name}} — `at` the acting node the platform
   * names, first, then every listed node below it that can hold a membership, in the platform's order: neither
   * archived nor below an archived node (an archived node suspends everything below it; the platform refuses
   * a home there); `names` the display name of each offered node that has one (#785: the acting node's
   * `at_display_name`, each listed node's `display_name`) — a node with no entry is unnamed, shown by its last
   * path segment. Rejects when the answer names no acting node — nothing is offered on a guess.
   */
  homes: (options) =>
    api('GET', `${MEMBERS_PATH}/nodes`, undefined, options).then(({ at, at_display_name: atName, nodes }) => {
      if (typeof at !== 'string' || !at.startsWith('/')) throw new Error('the node listing names no acting node');
      const archived = nodes.filter((n) => n.status === 'archived').map((n) => n.org_path);
      const offered = nodes.filter((n) => !archived.some((a) => atOrBelow(n.org_path, a)));
      const names = Object.fromEntries(
        [[at, atName], ...offered.map((n) => [n.org_path, n.display_name])].filter(([, name]) => typeof name === 'string' && name !== ''),
      );
      return { at, nodes: [at, ...offered.map((n) => n.org_path)], names };
    }),
  /** Create the node `orgPath` strictly below the caller, named `displayName` when given (#785). */
  create: ({ orgPath, displayName }, options) =>
    api('POST', `${MEMBERS_PATH}/nodes`, defined({ org_path: orgPath, display_name: displayName }), options),
  /** Set the display name of `node` (#785): trimmed and held to the platform's node-name grammar there. */
  rename: (node, displayName, options) =>
    api('PATCH', at(`${MEMBERS_PATH}/nodes`, { node }), { display_name: displayName }, options),
  /** Suspend `node` and everything below it (reversible). */
  archive: (node, options) => api('POST', at(`${MEMBERS_PATH}/nodes/archive`, { node }), undefined, options),
  /** Lift the archive of `node`. */
  unarchive: (node, options) => api('POST', at(`${MEMBERS_PATH}/nodes/unarchive`, { node }), undefined, options),
  /** Erase an archived `node` whose archive has settled. */
  remove: (node, options) => api('DELETE', at(`${MEMBERS_PATH}/nodes`, { node }), undefined, options),
};

export const workspaces = {
  /**
   * Create a workspace named `displayName` for the signed-in end user: 201 {org_path, membership_id,
   * selected}. `selected: false` means the creation succeeded but the session still acts through its
   * previous membership (the projection did not carry the new one within its bound, run decision D88):
   * select it at the switcher — never retry, which would create a second workspace.
   */
  create: ({ displayName }, options) => api('POST', WORKSPACES_PATH, { display_name: displayName }, options),
};
