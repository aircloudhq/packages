// @aircloudhq/testing — the invocation's correlation id, resolved as the functions host resolves it.
//
// The rule's one carrier is contracts/functions/v1/correlation-v1.json (projected into
// generated/contract-data.js as CONTRACT.correlation); the host is held to the same vectors by
// functions/src/invoke.rs correlation_contract_vectors. An entry surface honours an inbound header
// value that parses as a UUID under the uuid crate's grammar (Uuid::parse_str) and answers with its
// lowercase hyphenated text; any other value, or none, is replaced by a freshly minted id. That id is
// the invocation's ONE id: the guest's request carries it under the header, and every capability call
// of the invocation carries it (functions/src/admission.rs guest_request_headers, caps_*.rs).
//
// The current invocation is tracked with AsyncLocalStorage, so two invocations in flight at once
// (a test's Promise.all) keep their own ids across their awaits, as two host invocations do.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { CONTRACT } from "../generated/contract-data.js";

export const CORRELATION_HEADER = CONTRACT.correlation.header;

const HEX32 = /^[0-9a-fA-F]{32}$/;
const HYPHENATED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The uuid crate's Uuid::parse_str, answered as the canonical lowercase hyphenated text, or null. */
function parseUuid(s) {
  let h = s;
  if (h.length === 38 && h.startsWith("{") && h.endsWith("}")) h = h.slice(1, -1);
  else if (h.length === 45 && h.startsWith("urn:uuid:")) h = h.slice(9);
  else if (HEX32.test(h)) {
    const x = h.toLowerCase();
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }
  return HYPHENATED.test(h) ? h.toLowerCase() : null;
}

/** Mint an id the way the host's entry surface does (Uuid::new_v4). */
function mint() {
  if (CONTRACT.correlation.mintedVersion !== 4) {
    throw new Error(`@aircloudhq/testing defect: the contract mints version ${CONTRACT.correlation.mintedVersion}, this double mints 4`);
  }
  return randomUUID();
}

/** Resolve the invocation's id from the inbound header value (null when absent). */
export function resolveCorrelationId(inbound) {
  return (inbound === null ? null : parseUuid(inbound)) ?? mint();
}

const current = new AsyncLocalStorage();

/** Run `fn` as the invocation whose correlation id is `id`. */
export function withInvocation(id, fn) {
  return current.run(id, fn);
}

/**
 * The correlation id a capability call carries: the running invocation's. A call made outside
 * `invoke` (a unit test calling a binding directly) is its own invocation and gets a minted id.
 */
export function callCorrelationId() {
  return current.getStore() ?? mint();
}
