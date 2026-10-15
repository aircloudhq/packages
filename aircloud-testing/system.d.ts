// @aircloudhq/testing/system — helpers for a product's system tests (Playwright). See system.js.

/** The sessions file format version the platform test-runner writes (`aircloud test redeem`). */
export const SESSIONS_VERSION: 1;

/** The slice of a Playwright BrowserContext signInAs uses. */
export interface CookieContext {
  addCookies(
    cookies: Array<{ name: string; value: string; url: string; secure: boolean; httpOnly: boolean; sameSite: "Lax" }>,
  ): Promise<void>;
}

/**
 * Sign a browser context in as a test principal test/principals.toml declares (ADR-262), using the session the
 * platform test-runner redeemed once for this verification run. Refuses by name outside a verification run.
 */
export function signInAs(context: CookieContext, principal: string, options?: { sessionsFile?: string }): Promise<void>;
