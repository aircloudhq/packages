// @aircloudhq/testing — the error surface a guest sees, and the double's own misuse error.
//
// WHAT A GUEST CATCHES. componentize-js lowers a WIT `result<T, E>` import through jco's binding
// conventions: the ok arm is the return value, and the err arm is THROWN as a `ComponentError`
// whose `payload` is the error value — here the `error-envelope` record
// ({ code, message, correlationId, details }). The class below is the jco intrinsic verbatim
// (it ships inside @bytecodealliance/componentize-js 0.21.0, the versions.json pin — extracted and
// compared 2026-09-25), so a Builder's `catch (e) { e.payload.code }` behaves the same under this
// double and inside the built component. A double that threw the bare envelope would let
// `e.code` pass here and read `undefined` live.
export class ComponentError extends Error {
  constructor(value) {
    const enumerable = typeof value !== "string";
    super(enumerable ? `${String(value)} (see error.payload)` : value);
    Object.defineProperty(this, "payload", { value, enumerable });
  }
}

// A capability refusal raised INSIDE a semantics implementation. The binder converts it into the
// guest-visible ComponentError after stamping the invocation's correlation id; semantics never
// construct envelopes themselves, so the envelope shape has one author.
export class CapabilityFailure extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = "CapabilityFailure";
    this.code = code;
    this.detail = message;
    this.details = details === undefined ? {} : details;
  }
}

// The TEST-AUTHORING error: the double was asked to do something it cannot answer truthfully —
// an egress with no responder, an unknown fault code, a malformed seed. It is deliberately NOT a
// ComponentError, so a guest's own `catch` for capability errors cannot swallow it into a green
// test: a double that invented an answer would pass for the wrong reason.
export class DoubleMisuseError extends Error {
  constructor(message) {
    super(`@aircloudhq/testing: ${message}`);
    this.name = "DoubleMisuseError";
  }
}

/** Throw a capability refusal. `code` must be a code the platform can emit (checked by the binder). */
export function fail(code, message, details) {
  throw new CapabilityFailure(code, message, details);
}
