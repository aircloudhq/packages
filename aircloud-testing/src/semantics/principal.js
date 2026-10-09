// @aircloudhq/testing — the end-user principal interface (functions/src/caps_principal.rs; #632
// ADR-241 decision 4, plan W15.4/W15.7).
//
// On the platform the functions-host route trigger verifies the web-origin's principal assertion and
// hands the guest the end user of a `session` route; every other invocation has none. Under node:test
// the test decides: `world.principal.signIn({ sub, orgPath, roles, act, flash })` makes the next
// invocations a session route's, and `world.reset()` returns to a public one. The answers are the
// host's: `current()` the principal, `flash()` the message the platform took out of the session for
// this request, `csrfToken()` the session's token, and `setFlash(text)` records the next request's
// flash on `world.principal.flashOut` — `functions.validation` outside a session or out of bounds.
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";

/** == functions/src/caps_principal.rs MAX_FLASH_BYTES (the web-origin's FLASH_MAX_BYTES). */
const MAX_FLASH_BYTES = 4096;

export function createPrincipalState(w) {
  let session = null;
  const state = {
    /** The flash the guest set for the next request (null until it sets one). */
    flashOut: null,
    /** Sign an end user in: the invocations that follow serve a `session` route. */
    signIn({ sub, tenantId, orgPath = "/", roles = [], act, flash, csrf } = {}) {
      if (typeof sub !== "string" || sub === "") throw new DoubleMisuseError("principal.signIn: sub is required");
      if (typeof orgPath !== "string" || !orgPath.startsWith("/")) {
        throw new DoubleMisuseError(`principal.signIn: orgPath '${String(orgPath)}' is not a tree path`);
      }
      session = {
        sub,
        tenantId: tenantId ?? w.newId(),
        orgPath,
        roles: [...roles],
        act: typeof act === "string" ? act : act === undefined ? undefined : JSON.stringify(act),
        flash: flash ?? undefined,
        csrf: csrf ?? `${w.newId()}${w.newId()}`.replace(/-/g, ""),
      };
    },
    current() {
      if (!session) return undefined;
      const { sub, tenantId, orgPath, roles, act } = session;
      return { sub, tenantId, orgPath, roles, act };
    },
    flash() {
      return session ? session.flash : undefined;
    },
    csrfToken() {
      return session ? session.csrf : undefined;
    },
    setFlash(message) {
      const refuse = (m) => {
        throw new CapabilityFailure("functions.validation", m, { max_bytes: MAX_FLASH_BYTES });
      };
      if (!session) refuse("this invocation serves no end-user session");
      if (typeof message !== "string" || message === "" || Buffer.byteLength(message) > MAX_FLASH_BYTES || /\p{Cc}/u.test(message)) {
        refuse("the flash must be 1..=4096 bytes of text without control characters");
      }
      state.flashOut = message;
    },
  };
  return state;
}
