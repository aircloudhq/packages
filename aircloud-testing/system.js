// @aircloudhq/testing/system — a product's system tests (Playwright).
//
//   import { expect, signInAs, test } from "@aircloudhq/testing/system";
//   test("staff lists pets", async ({ context, page }) => {
//     await signInAs(context, "staff");
//     await page.goto("/pet/");
//     await expect(page.getByRole("heading", { name: "Pets" })).toBeVisible();
//   });
//
// test is Playwright's test with a guarded browser context (#719 AC4, ADR-270, src/csp-guard.js):
// every page and every interaction of each test runs under the product's Content-Security-Policy,
// and the test fails on any violation — one raised at load, after a navigation, or by an interaction
// such as opening a dialog or showing a toast. expect is Playwright's, re-exported so a spec has one
// import.
//
// signInAs (ADR-262 decisions 3 and 5): in a release's verification run the platform test-runner redeemed
// each principal test/principals.toml declares ONCE, on the run's ci- host, and wrote the sessions file the
// environment variable AIR_VERIFICATION_SESSIONS names. signInAs loads one principal's session cookies into a
// browser context for that host — it never redeems a token itself, so the api and system layers share the
// same sessions. Outside a verification run there is no sessions file, and it refuses by name rather than
// let the test run anonymously.
import { readFile } from "node:fs/promises";
import { test as base, expect } from "@playwright/test";
import { guardCsp } from "./src/csp-guard.js";

export { expect };

/** Playwright's test, its `context` fixture guarded by the product's Content-Security-Policy. */
export const test = base.extend({
  context: async ({ context }, use) => guardCsp(context, use),
});

/** The sessions file format version the platform test-runner writes (`aircloud test redeem`). */
export const SESSIONS_VERSION = 1;

/**
 * Sign a Playwright browser context in as a declared test principal.
 * @param {{ addCookies(cookies: object[]): Promise<void> }} context a Playwright BrowserContext
 * @param {string} principal a name test/principals.toml declares
 * @param {{ sessionsFile?: string }} [options] the sessions file (default: AIR_VERIFICATION_SESSIONS)
 */
export async function signInAs(context, principal, options = {}) {
  const file = options.sessionsFile ?? process.env.AIR_VERIFICATION_SESSIONS;
  if (!file) {
    throw new Error(
      `signInAs(${JSON.stringify(principal)}): no verification sessions — a principal's session exists only in a ` +
        "release's verification run (AIR_VERIFICATION_SESSIONS is unset)",
    );
  }
  const doc = JSON.parse(await readFile(file, "utf8"));
  if (doc.version !== SESSIONS_VERSION || typeof doc.base_url !== "string") {
    throw new Error(`signInAs: ${file} is not a version-${SESSIONS_VERSION} sessions file`);
  }
  const session = doc.principals?.[principal];
  if (!session || !Array.isArray(session.cookies) || session.cookies.length === 0) {
    throw new Error(
      `signInAs(${JSON.stringify(principal)}): the run holds no session for this principal — declare it in ` +
        "test/principals.toml",
    );
  }
  await context.addCookies(
    session.cookies.map((c) => ({
      name: c.name,
      value: c.value,
      url: doc.base_url,
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })),
  );
}
