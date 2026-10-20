// @aircloudhq/testing/system — a product's system tests (Playwright). See system.js.
import type { test as base } from "@playwright/test";

/** Playwright's expect, re-exported so a spec imports everything it needs from one module. */
export { expect } from "@playwright/test";

/**
 * Playwright's test with a guarded browser context (#719, ADR-270): every page and every interaction
 * of each test runs under the product's Content-Security-Policy, and the test fails on any
 * violation — at load, after a navigation, or one an interaction triggers (opening a dialog,
 * showing a toast). Its fixtures are Playwright's own.
 */
export declare const test: typeof base;

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
