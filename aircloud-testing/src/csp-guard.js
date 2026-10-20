// The guarded browser context of @aircloudhq/testing/system (#719 AC4, ADR-270, ADR-224): every
// page of a system test's context reports each Content-Security-Policy violation to the test
// process the moment the browser raises it, and the test fails at teardown when any arrived.
//
// Why a fixture and not a call the spec makes: a violation is raised by whatever the test just did —
// loading a page, opening a dialog, showing a toast — so a check placed by hand after some
// interactions misses the others, and a page-global collector is lost at every navigation. The
// collector lives in the TEST process (a context binding), so it survives navigations, new
// documents and new pages; the listener is an init script, so it is attached before any page
// script runs in every document and frame.
//
// The flush: a binding call from the page travels the same ordered channel as an evaluate's reply,
// so one evaluate round-trip on each still-open page, after the test body returns, delivers every
// violation raised before it — including one the test's final action triggered.

/** The binding name the init script reports through (one per context). */
export const CSP_BINDING = "__aircloudCspViolation";

/**
 * The init script: runs in every document of the context before its scripts, forwarding each
 * `securitypolicyviolation` to the binding. Serialized by Playwright — it must close over nothing.
 * @param {string} binding the exposed binding's name
 */
export function forwardCspViolations(binding) {
  document.addEventListener(
    "securitypolicyviolation",
    (e) => {
      window[binding]({
        directive: e.effectiveDirective || e.violatedDirective,
        blockedURI: e.blockedURI,
        sample: e.sample,
        sourceFile: e.sourceFile,
        lineNumber: e.lineNumber,
      });
    },
    true,
  );
}

/**
 * The guarded `context` fixture's body: install the collector, run the test, flush every open
 * page, and fail naming each violation when any arrived.
 * @param {import("@playwright/test").BrowserContext} context
 * @param {(context: import("@playwright/test").BrowserContext) => Promise<void>} use
 */
export async function guardCsp(context, use) {
  const collected = [];
  await context.exposeBinding(CSP_BINDING, (source, violation) => {
    collected.push({ ...violation, url: source.page ? source.page.url() : undefined });
  });
  await context.addInitScript(forwardCspViolations, CSP_BINDING);
  await use(context);
  for (const page of context.pages()) {
    if (!page.isClosed()) {
      await page.evaluate(() => 0);
    }
  }
  if (collected.length > 0) {
    const rendered = collected
      .map((v) => `  - ${v.directive || "?"} blocked ${v.blockedURI || "?"} on ${v.url || "?"}`)
      .join("\n");
    throw new Error(
      `the product's Content-Security-Policy was violated during this test: ${collected.length} violation(s)\n${rendered}`,
    );
  }
}
