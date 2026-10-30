// @aircloudhq/testing — the semantics registry: one behaviour per WIT capability function.
//
// THE SPLIT, and why it is the whole design. The SURFACE of the double — which interfaces exist,
// which functions, their parameter and result types, the error codes the platform can emit, the
// gated meters, the capture arm of each capability — is GENERATED from the contracts by
// scripts/dev/gen-aircloud-testing.sh and never hand-kept. BEHAVIOUR cannot be generated: a WIT
// signature says nothing about what a query returns. So behaviour lives here, keyed by the WIT
// name, and the generator REFUSES to emit a binding for a WIT function with no entry below — a
// capability added to the WIT cannot silently be missing from the double; the regeneration fails
// naming it (the regen-diff gate, test/unit/capability_testing_gen.bats).
//
// An entry whose WIT function does not exist yet is not bound (nothing can reach it) and is listed
// as UNBOUND in the generated manifest, where the gate checks it against the additions the release
// runtime spec declares (credential.hmac-sign / hmac-verify, § Secret custody).
//
// Every function receives (world, ...loweredArgs) and returns the jco representation of its WIT
// result, or throws CapabilityFailure. Semantics modules never import world.js or generated data:
// the generator imports this registry, and it must load before anything has been generated.
import { createActingNodeState } from "./acting-node.js";
import { createProjectionState } from "./authz.js";
import { createBusState } from "./bus.js";
import { CONSENT_HTTPERR_CODES, createCommsState } from "./comms.js";
import { createCredentialState } from "./credential.js";
import { createEntriesState } from "./entries.js";
import { createFlexGovernanceState } from "./flex-governance.js";
import { createOrgState, ORG_HTTPERR_CODES } from "./org.js";
import { createFlexState, FLEX_METERS } from "./flex.js";
import { createI18nState } from "./i18n.js";
import { createPrincipalState } from "./principal.js";
import { createQuotaState } from "./quota.js";

export const STATE_FACTORIES = {
  projection: createProjectionState,
  quota: createQuotaState,
  flex: createFlexState,
  credential: createCredentialState,
  bus: createBusState,
  comms: createCommsState,
  i18n: createI18nState,
  principal: createPrincipalState,
  actingNode: createActingNodeState,
  entries: createEntriesState,
  flexGovernance: createFlexGovernanceState,
  org: createOrgState,
};

export const SEMANTICS = {
  "flex-query.query": (w, entity, q) => w.flex.query(entity, q),
  "flex-query.get-record": (w, entity, id) => w.flex.getRecord(entity, id),
  // #384 ADR-295 decision 8: the declared elevated aggregate.
  "flex-query.aggregate-elevated": (w, entity, q) => w.flex.aggregateElevated(entity, q),
  "flex-mutate.create-record": (w, entity, rec) => w.flex.createRecord(entity, rec),
  "flex-mutate.update-record": (w, entity, id, patch) => w.flex.updateRecord(entity, id, patch),
  "flex-mutate.delete-record": (w, entity, id) => w.flex.deleteRecord(entity, id),
  "flex-schema.create-entity": (w, json) => w.flex.createEntity(json),
  "flex-schema.list-entities": (w) => w.flex.listEntities(),
  "flex-schema.get-entity": (w, name) => w.flex.getEntity(name),
  "flex-schema.delete-entity": (w, name) => w.flex.deleteEntity(name),
  "flex-schema.add-field": (w, entity, json) => w.flex.addField(entity, json),
  "flex-schema.update-field": (w, entity, field, json) => w.flex.updateField(entity, field, json),
  "flex-schema.remove-field": (w, entity, field) => w.flex.removeField(entity, field),
  "flex-schema.update-entity": (w, name, json) => w.flex.updateEntity(name, json),
  // #384 D79/D80: Flex's governance surface, answered by the test's responders (./flex-governance.js).
  "flex-query.explain": (w, ...args) => w.flexGovernance.call("explain", args),
  // #384 D102/D112: the field policy in force at a node, from the double's own compiled rules.
  "flex-query.policy": (w, entity, at) => JSON.stringify(w.flex.policy(entity, at)),
  "flex-schema.put-policy": (w, ...args) => w.flexGovernance.call("put-policy", args),
  "flex-schema.delete-policy": (w, ...args) => w.flexGovernance.call("delete-policy", args),
  "flex-schema.create-changeset": (w, ...args) => w.flexGovernance.call("create-changeset", args),
  "flex-schema.get-changeset": (w, ...args) => w.flexGovernance.call("get-changeset", args),
  "flex-schema.update-changeset": (w, ...args) => w.flexGovernance.call("update-changeset", args),
  "flex-schema.discard-changeset": (w, ...args) => w.flexGovernance.call("discard-changeset", args),
  "flex-schema.diff-changeset": (w, ...args) => w.flexGovernance.call("diff-changeset", args),
  "flex-schema.changeset-impact": (w, ...args) => w.flexGovernance.call("changeset-impact", args),
  "flex-schema.publish-changeset": (w, ...args) => w.flexGovernance.call("publish-changeset", args),
  "flex-schema.create-rollback": (w, ...args) => w.flexGovernance.call("create-rollback", args),
  "quota.check": (w, req) => w.quota.check(req),
  "credential.egress": (w, req) => w.credential.egress(req),
  "credential.hmac-sign": (w, handle, alg, msg) => w.credential.hmacSign(handle, alg, msg),
  "credential.hmac-verify": (w, handle, alg, msg, sig) => w.credential.hmacVerify(handle, alg, msg, sig),
  "bus.publish": (w, req) => w.bus.publish(req),
  "comms-mail.send": (w, req) => w.comms.sendMail(req),
  "comms-whatsapp.send": (w, req) => w.comms.sendWhatsapp(req),
  "comms-consent.grant": (w, req) => w.comms.grant(req),
  "comms-consent.revoke": (w, req) => w.comms.revoke(req),
  "comms-consent.list-consents": (w) => w.comms.listConsents(),
  "comms-suppression.list-suppressions": (w) => w.comms.listSuppressions(),
  // The guest package's function-runtime interface (#645, ADR-223 D3) — not a capability.
  "i18n.locales": (w) => w.i18n.locales(),
  "i18n.bundle": (w, locale) => w.i18n.bundle(locale),
  "i18n.key-missing": (w, locale, key) => w.i18n.keyMissing(locale, key),
  "principal.current": (w) => w.principal.current(),
  "principal.flash": (w) => w.principal.flash(),
  "principal.set-flash": (w, message) => w.principal.setFlash(message),
  "principal.csrf-token": (w) => w.principal.csrfToken(),
  // #384: which of the end user's memberships the session selected (ADR-293 decision 9).
  "principal.membership-id": (w) => w.principal.membershipId(),
  // #384 D105: the selected membership's effective grants and its roles at a node, from the projection.
  "principal.grants": (w) => w.principal.grants(),
  "principal.roles-at": (w, node) => w.principal.rolesAt(node),
  // #384 ADR-295 decision 2: the invocation's acting node, narrowed only downward.
  "acting-node.current": (w) => w.actingNode.current(),
  "acting-node.narrow": (w, path) => w.actingNode.narrow(path),
  // #384 F3 / ADR-295 decision 6: the tree capabilities, each refused unless declared (./org.js).
  "org-nodes.list-nodes": (w) => JSON.stringify(w.org.listNodes()),
  "org-nodes.create-node": (w, json) => JSON.stringify(w.org.createNode(json)),
  "org-nodes.archive-node": (w, node) => w.org.setStatus("nodes.archive", node, "archived"),
  "org-nodes.unarchive-node": (w, node) => w.org.setStatus("nodes.unarchive", node, "active"),
  "org-nodes.delete-node": (w, node) => w.org.deleteNode(node),
  "members.list-members": (w, under) => JSON.stringify(w.org.listMembers(under)),
  "members.invite": (w, json) => JSON.stringify(w.org.invite(json)),
  "members.update": (w, membershipId, json) => w.org.updateMember(membershipId, json),
  "members.remove": (w, membershipId, block) => w.org.removeMember(membershipId, block),
  "members.unblock": (w, email) => w.org.unblock(email),
  "members.grant": (w, membershipId, json) => JSON.stringify(w.org.grant(membershipId, json)),
  "members.revoke-grant": (w, membershipId, grantId) => w.org.revokeGrant(membershipId, grantId),
  "members.memberships": (w, userId) => JSON.stringify(w.org.memberships(userId)),
  "profiles.list-profiles": (w, at) => JSON.stringify(w.org.listProfiles(at)),
  "profiles.put": (w, node, name, json) => JSON.stringify(w.org.putProfile(node, name, json)),
  "profiles.remove": (w, node, name) => w.org.removeProfile(node, name),
  "groups.list-groups": (w) => JSON.stringify(w.org.listGroups()),
  "groups.put": (w, json) => JSON.stringify(w.org.putGroup(json)),
  "groups.remove": (w, node, name) => w.org.removeGroup(node, name),
  "groups.add-member": (w, node, name, json) => w.org.addGroupMember(node, name, json),
  "groups.remove-member": (w, node, name, id) => w.org.removeGroupMember(node, name, id),
  "denies.list-denies": (w) => JSON.stringify(w.org.listDenies()),
  "denies.put": (w, json) => JSON.stringify(w.org.putDeny(json)),
  "denies.remove": (w, id) => w.org.removeDeny(id),
  "workspaces.create": (w, json) => JSON.stringify(w.org.createWorkspace(json)),
};

/** Gated meters the semantics admit under — each must be `gated` in the metering registry. */
export const METERS_USED = [...Object.values(FLEX_METERS), "comms.mail.send", "comms.whatsapp.send"];

/** Error codes the semantics raise that no errors contract carries (declared mirrors, cited). */
export const EXTRA_CODES = [...new Set([...CONSENT_HTTPERR_CODES, ...ORG_HTTPERR_CODES])];
