// @aircloudhq/testing — the schema governance surface of Flex (#384 D80; `flex-schema` put-policy …
// create-rollback, `flex-query.explain`): policies, changesets, rollbacks and the decision explanation.
//
// These are answered by Flex's governance engine — changeset diffing and impact, publication, rollback,
// and the explanation of a decision from its compiled artifact (D79) — which the double does not
// re-implement: a double that invented a diff or a verdict would let a test pass for the wrong reason.
// So, like a credential egress, each call is answered by a RESPONDER the test registers:
// `world.flexGovernance.answer("publish-changeset", (id) => ({ ... }))` (the WIT function name; the
// handler receives the call's arguments, bodies parsed, and returns the document Flex would answer, or
// throws a CapabilityFailure via `fail`). A call with no responder is the test's mistake
// (DoubleMisuseError), never a fabricated answer. Every call still carries the host's acting-node
// assertion, so an archived acting node is refused as the host refuses it.
import { DoubleMisuseError } from "../errors.js";

/** The WIT functions this module answers (interface-qualified). */
export const GOVERNANCE_FUNCTIONS = [
  "flex-query.explain",
  "flex-schema.put-policy",
  "flex-schema.delete-policy",
  "flex-schema.create-changeset",
  "flex-schema.get-changeset",
  "flex-schema.update-changeset",
  "flex-schema.discard-changeset",
  "flex-schema.diff-changeset",
  "flex-schema.changeset-impact",
  "flex-schema.publish-changeset",
  "flex-schema.create-rollback",
];

export function createFlexGovernanceState(w) {
  const responders = new Map();
  const calls = [];
  return {
    /** Register the answer of one governance function (its WIT name, e.g. "publish-changeset"). */
    answer(fn, handler) {
      if (!GOVERNANCE_FUNCTIONS.some((q) => q.endsWith(`.${fn}`))) {
        throw new DoubleMisuseError(`flexGovernance.answer: '${String(fn)}' is not a Flex governance function`);
      }
      if (typeof handler !== "function") throw new DoubleMisuseError("flexGovernance.answer takes a handler function");
      responders.set(fn, handler);
    },
    /** Every governance call, in order: { fn, args }. */
    calls() {
      return calls.map((c) => ({ ...c }));
    },
    call(fn, args) {
      w.actingNode.hostAssertion();
      const parsed = args.map((a) => {
        if (typeof a !== "string" || !/^\s*[{[]/.test(a)) return a;
        try {
          return JSON.parse(a);
        } catch {
          return a;
        }
      });
      calls.push({ fn, args: parsed });
      const h = responders.get(fn);
      if (!h) {
        throw new DoubleMisuseError(
          `flex-schema/flex-query ${fn}: the double does not model Flex's governance engine — register the answer Flex would give with world.flexGovernance.answer("${fn}", handler)`,
        );
      }
      const out = h(...parsed);
      return typeof out === "string" ? out : JSON.stringify(out ?? {});
    },
  };
}
