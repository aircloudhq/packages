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
import { createBusState } from "./bus.js";
import { CONSENT_HTTPERR_CODES, createCommsState } from "./comms.js";
import { createCredentialState } from "./credential.js";
import { createFlexState, FLEX_METERS } from "./flex.js";
import { createI18nState } from "./i18n.js";
import { createQuotaState } from "./quota.js";

export const STATE_FACTORIES = {
  quota: createQuotaState,
  flex: createFlexState,
  credential: createCredentialState,
  bus: createBusState,
  comms: createCommsState,
  i18n: createI18nState,
};

export const SEMANTICS = {
  "flex-query.query": (w, entity, q) => w.flex.query(entity, q),
  "flex-query.get-record": (w, entity, id) => w.flex.getRecord(entity, id),
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
};

/** Gated meters the semantics admit under — each must be `gated` in the metering registry. */
export const METERS_USED = [...Object.values(FLEX_METERS), "comms.mail.send", "comms.whatsapp.send"];

/** Error codes the semantics raise that no errors contract carries (declared mirrors, cited). */
export const EXTRA_CODES = [...CONSENT_HTTPERR_CODES];
