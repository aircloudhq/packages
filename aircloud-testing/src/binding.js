// @aircloudhq/testing — the binder every generated `aircloud:capability/*` module calls.
//
// One WIT function → one guest-callable JS function that does what the component boundary does:
//   1. arity and LOWERING checks (a wrong-shaped argument is a TypeError, as jco raises it);
//   2. the call is recorded on `world.calls` with the invocation's correlation id (src/correlation.js);
//   3. a fault injected for this function refuses it first (`world.faults.inject`);
//   4. the semantics run; a CapabilityFailure becomes the guest-visible ComponentError whose
//      payload is the error-envelope record, its `details` the JSON TEXT the WIT declares;
//   5. the result is LIFTED and checked against the WIT result type, so the double can never hand
//      a guest a shape the real binding would not.
import { CONTRACT } from "../generated/contract-data.js";
import { KNOWN_CODES } from "./codes.js";
import { callCorrelationId } from "./correlation.js";
import { CapabilityFailure, ComponentError, DoubleMisuseError } from "./errors.js";
import { SEMANTICS } from "./semantics/index.js";
import { camel, checkValue } from "./wit-types.js";
import { world } from "./world.js";

export function bind(ifaceName, fnName) {
  const iface = CONTRACT.wit.interfaces.find((i) => i.name === ifaceName);
  const fn = iface && iface.functions.find((f) => f.name === fnName);
  const key = `${ifaceName}.${fnName}`;
  const impl = SEMANTICS[key];
  if (!fn || !impl) throw new Error(`@aircloudhq/testing: ${key} is not bound — regenerate (scripts/dev/gen-aircloud-testing.sh)`);
  const jsName = camel(fnName);
  // A function-runtime interface (the guest package's own, e.g. i18n) is not a capability: the host
  // links it to every guest in every environment, so it has no link-set arm.
  const runtime = CONTRACT.runtime.includes(ifaceName);
  const capability = runtime ? null : CONTRACT.capabilityOf[key];
  const lowerFault = (m) => new TypeError(`${ifaceName}.${jsName}: ${m}`);
  const liftFault = (m) => new Error(`@aircloudhq/testing defect: ${key} returned a value the WIT result type forbids — ${m}`);

  const bound = function (...args) {
    if (args.length !== fn.params.length) {
      throw new TypeError(`${ifaceName}.${jsName} takes ${fn.params.length} argument(s), got ${args.length}`);
    }
    const lowered = fn.params.map((p, i) => checkValue(CONTRACT.wit, p.type, args[i], camel(p.name), lowerFault));
    const correlationId = callCorrelationId();
    const call = { interface: ifaceName, function: fnName, capability, args: lowered, correlationId, environment: world.environment };
    world.calls.push(call);
    let out;
    try {
      const arm = runtime ? "real" : world.linkArm(capability);
      if (arm === "deny") {
        // functions/src/caps_*.rs: an external capability the environment's link-set denies.
        throw new CapabilityFailure("functions.sandbox_denied", `${capability} is denied in environment ${world.environment}`, { capability });
      }
      if (arm !== "real" && arm !== "capture") {
        throw new DoubleMisuseError(`${capability}: the '${arm}' link-set arm is not modelled by this double`);
      }
      const fault = world.faults.take(key);
      if (fault) throw new CapabilityFailure(fault.code, fault.message, fault.details);
      out = impl(world, ...lowered);
    } catch (e) {
      if (!(e instanceof CapabilityFailure)) throw e;
      if (!KNOWN_CODES.has(e.code)) throw new Error(`@aircloudhq/testing defect: ${key} raised '${e.code}', which no errors contract declares`);
      call.outcome = { error: e.code };
      if (!fn.result || fn.result.kind !== "result" || !fn.result.err) {
        throw new Error(`@aircloudhq/testing defect: ${key} has no error arm in the WIT but refused with ${e.code}`);
      }
      throw new ComponentError({ code: e.code, message: e.detail, correlationId, details: JSON.stringify(e.details) });
    }
    call.outcome = { ok: true };
    if (!fn.result) return undefined;
    if (fn.result.kind === "result") return fn.result.ok ? checkValue(CONTRACT.wit, fn.result.ok, out, "result", liftFault) : undefined;
    return checkValue(CONTRACT.wit, fn.result, out, "result", liftFault);
  };
  Object.defineProperty(bound, "name", { value: jsName });
  return bound;
}
