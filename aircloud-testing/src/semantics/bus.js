// @aircloudhq/testing — Air-Bus Builder publish (functions/src/caps_bus.rs, the host's pre-flight and forward;
// control-plane/internal/capgw/buspublish.go, the executor).
//
// The host refuses a malformed idempotency key in the capability gateway's envelope (`capability.validation`,
// details.field idempotency_key), validates the topic against the ADR-078 slug grammar and the payload as a JSON
// document (`functions.validation`, the host's own messages), then forwards to the gateway. The gateway refuses a
// payload that is not a JSON object (`capability.validation`, "payload must be a JSON object") or not I-JSON
// (`capability.validation`, details.field payload and its reason), and keys the event (ADR-302 decision 8): its id is
// IDv5(NS_BUS_APP_EVENT, tenant ‖ acting node ‖ environment ‖ acting principal ‖ topic ‖ key), a retry of the key with
// the same canonical payload answers that id and records nothing new, and a different payload is
// `capability.idempotency_key_reused` (details: the first event's id and when it was first seen). The key is
// remembered for the life of the world (the tenant's). The gateway publishes nothing itself: the event is recorded in
// the tenant's transaction and the platform's outbox relay publishes it — in this world it is "published" the
// moment it is recorded, the relay being the platform's, not the function's. Published events are kept on
// `world.bus.published` with the payload parsed and the envelope's attribution: an event an invocation publishes is
// its function's (`actorId: "fn:<function>"`, the name the host's acting assertion signs); a binding called outside
// `invoke` carries no assertion, so its actor is the runtime identity's sub, as the gateway answers an unasserted
// call. The double never answers `capability.effect_in_progress` (no twin is ever in flight in one world). A payload
// whose canonical form alone exceeds events-v1's maximum message is refused as the host refuses it before the call
// (`capability.payload_too_large`, the gateway's message, details.field payload and the bound; caps_bus.rs).
import { createHash } from "node:crypto";
import { CONTRACT } from "../../generated/contract-data.js";
import { callCorrelationId } from "../correlation.js";
import { CapabilityFailure } from "../errors.js";
import { RUNTIME_SUB } from "./authz.js";
import { currentFrame } from "./invocation.js";
import { busEventId, canonicalDocument, checkKey } from "./keys.js";

/** functions/src/caps_bus.rs EVENT_TOO_LARGE_MESSAGE (control-plane/internal/capgw/buspublish.go EventTooLargeMessage). */
export const EVENT_TOO_LARGE_MESSAGE = "the event exceeds the bus's maximum message size: publish a smaller payload";

/** functions/src/caps_bus.rs validate_topic. */
export function validateTopic(topic) {
  if (topic === "") return "topic must not be empty";
  for (const seg of topic.split(".")) {
    if (seg.length === 0 || Buffer.byteLength(seg) > 63) return `topic segment '${seg}' is empty or too long`;
    if (!/^[a-z]/.test(seg)) return `topic segment '${seg}' must start with a-z`;
    if (!/^[a-z][a-z0-9-]*$/.test(seg)) return `topic segment '${seg}' violates the slug grammar [a-z][a-z0-9-]*`;
  }
  return null;
}

export function createBusState(world) {
  const published = [];
  // The key rows: event id → {digest, firstSeenAt}.
  const keys = new Map();
  return {
    get published() { return published; },
    /** The parsed payloads published on one topic, in order. */
    payloads(topic) { return published.filter((e) => e.topic === topic).map((e) => e.payload); },
    publish(req) {
      // The host's pre-flight (caps_bus.rs), in its order.
      checkKey("capability.validation", req.idempotencyKey);
      const err = validateTopic(req.topic);
      if (err) throw new CapabilityFailure("functions.validation", err, {});
      let payload;
      try { payload = JSON.parse(req.payload); } catch (e) {
        throw new CapabilityFailure("functions.validation", `payload is not valid JSON: ${e.message}`, {});
      }
      // The gateway's (buspublish.go): an object, then I-JSON, then the key.
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        throw new CapabilityFailure("capability.validation", "payload must be a JSON object", {});
      }
      const canonical = canonicalDocument("capability.validation", req.payload, "payload");
      if (Buffer.byteLength(canonical) > CONTRACT.busMessageMax) {
        throw new CapabilityFailure("capability.payload_too_large", EVENT_TOO_LARGE_MESSAGE, {
          field: "payload", max_message_bytes: CONTRACT.busMessageMax,
        });
      }
      const digest = createHash("sha256").update(canonical).digest("hex");
      // The acting principal: the runtime's service account, and the end user the invocation acts for.
      const principal = { plane: "service", sub: RUNTIME_SUB, act: world.principal.session()?.sub ?? "" };
      const orgPath = world.actingNode.current();
      const eventId = busEventId(world.tenantId, orgPath, world.environment, principal, req.topic, req.idempotencyKey);
      const prior = keys.get(eventId);
      if (prior) {
        if (prior.digest !== digest) {
          throw new CapabilityFailure("capability.idempotency_key_reused", "the idempotency key already names a different event (the canonical payload differs): publish a different event under a different key", {
            event_id: eventId, first_seen_at: prior.firstSeenAt,
          });
        }
        return { eventId };
      }
      keys.set(eventId, { digest, firstSeenAt: new Date(world.clock.nowMs()).toISOString() });
      const fn = currentFrame()?.function;
      published.push({
        eventId, topic: req.topic, payload, environment: world.environment, orgPath,
        actorId: fn ? `fn:${fn}` : RUNTIME_SUB, correlationId: callCorrelationId(),
      });
      return { eventId };
    },
  };
}
