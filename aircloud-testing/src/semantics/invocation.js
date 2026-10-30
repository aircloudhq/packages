// @aircloudhq/testing — the invocation an `invoke()` runs as: what the functions-host resolved for it before
// the guest ran (functions/src/acting_node.rs `ActingNode`, one per invocation).
//
// A frame is {entry, acting, session, elevate}: the ENTRY node (the bound of every narrowing), the node the next
// call acts at, whether the invocation serves the signed-in end user (a route) or none (an event, a cron, a
// direct invoke), and the invoked function's `[[elevate]]` declarations (release_model.rs). It is tracked with AsyncLocalStorage, as the correlation id is, so a narrowing ends with its
// invocation and two invocations in flight keep their own nodes — the host instantiates every invocation
// fresh. A capability call made outside `invoke` (a unit test calling a binding directly) has no frame and
// reads the world's declaration (`world.actingNode.enter`, `world.principal.signIn`).
import { AsyncLocalStorage } from "node:async_hooks";

const frames = new AsyncLocalStorage();

/** Run `fn` as the invocation `frame` describes. */
export function withFrame(frame, fn) {
  return frames.run(frame, fn);
}

/** The running invocation's frame, or null outside `invoke`. */
export function currentFrame() {
  return frames.getStore() ?? null;
}
