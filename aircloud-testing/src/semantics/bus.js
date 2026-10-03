// @aircloudhq/testing — Air-Bus Builder publish (functions/src/caps_bus.rs).
//
// The host validates the topic against the ADR-078 slug grammar and the payload as a JSON
// document, then publishes synchronously and returns the event id it minted. Both refusals are
// `functions.validation`, with the host's own messages. Published events are kept on
// `world.bus.published` with the payload parsed, so a test asserts on the document, not a string.
import { CapabilityFailure } from "../errors.js";

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
  return {
    get published() { return published; },
    /** The parsed payloads published on one topic, in order. */
    payloads(topic) { return published.filter((e) => e.topic === topic).map((e) => e.payload); },
    publish(req) {
      const err = validateTopic(req.topic);
      if (err) throw new CapabilityFailure("functions.validation", err, {});
      let payload;
      try { payload = JSON.parse(req.payload); } catch (e) {
        throw new CapabilityFailure("functions.validation", `payload is not valid JSON: ${e.message}`, {});
      }
      const eventId = world.newId();
      published.push({ eventId, topic: req.topic, payload, environment: world.environment });
      return { eventId };
    },
  };
}
