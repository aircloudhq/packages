# @aircloudhq/testing

In-memory doubles of every Air-Cloud capability a JavaScript function imports — Flex query /
mutate / schema, quota, credential (egress, and HMAC once the WIT carries it), bus, and the comms
mail / WhatsApp / consent / suppression interfaces — plus a harness that invokes a function through
its fetch listener. It is what a product's unit layer (`test/functions/<name>/`) runs against, in
the build sandbox and on a Builder's machine alike (ADR-218, ADR-219).

```js
// test/functions/pets/pets.test.js — from test/: npm run test:unit
import { beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import { world, invoke } from "@aircloudhq/testing";

beforeEach(() => {
  world.reset();
  world.flex.defineEntity({ name: "pet", fields: [{ name: "name", type: "text", required: true }] });
});

it("creates a pet", async () => {
  // through the [[route]] config/routes.toml declares at /api/pets
  const res = await invoke({ route: "/api/pets" },
    new Request("https://x/api/pets", { method: "POST", body: JSON.stringify({ name: "rex" }) }));
  assert.equal(res.status, 201);
  assert.equal(world.flex.records("pet").length, 1);
});
```

- **Through a declared entry.** `invoke(entry, request)` runs the function behind an entry the release
  declares — `{ route: "/api/pets" }`, `{ function: "notify", event: "pet.adopted" }`,
  `{ function: "notify", cron: "0 3 * * *" }`, or a direct invoke `{ function: "notify", orgPath }` — and
  acts at the node the platform resolves for it: the route's or trigger's `org_path`, an authenticated
  route's session home, the Builder's node for a direct invoke. An entry the release does not declare, or
  one without `org_path`, answers the platform's `409 functions.org_path_undeclared` and the function
  never runs. The entries are the release's, compiled by `aircloud test prepare` (npm test's pretest).
- **Sessions only where the platform carries one.** A public route serves no end user, whoever the test
  signed in with `world.principal.signIn`: the function sees no principal and acts at the route's
  `org_path`. An authenticated route needs a session (`401 session_required` without one) and, when it
  is narrowed to `roles`, a session holding one of them — at its membership's home, or at the route's
  `at` node or below — or it answers `403 session_role_required`, as the platform does.
- **Generated, never hand-kept.** The capability surface (interfaces, functions, types, error codes,
  gated meters, capture arms) is generated from the `aircloud:capability` WIT and the capability,
  errors and metering contracts; a capability added to the WIT cannot be missing here.
- **Errors as the component sees them.** A refusal throws `ComponentError` with the error-envelope
  on `e.payload` (`e.payload.code`, `e.payload.details` as JSON text) — jco's convention.
- **Environments.** `world.environment = "preview"` (any non-production name) switches external
  capabilities to their capture arm, as the platform's link-set does.
- **Faults.** `world.faults.inject("flex-query.query", { code: "flex.timeout" })` — only codes the
  platform can emit are accepted.
- **One correlation id per invocation.** `invoke` resolves it as the platform does — the request's
  `x-correlation-id` when it is a UUID, otherwise a fresh one — and the function's request carries it
  under that header; every capability call of the invocation carries it on `world.calls` and on a
  refusal's `e.payload.correlationId`.
- **Egress** never leaves the process: register answers with `world.credential.respond(...)`; an
  unanswered egress fails the test rather than inventing a reply.

## Migrating from 1.x

2.0.4 changes `invoke`'s signature: `invoke(entry, request)` names the declared entry the function runs
through, where 1.x took the function's module (`invoke("app/functions/pets/index.js", request)`, or
its `URL`). Replace the module with the entry — `{ route: "/api/pets" }` for the route
`config/routes.toml` declares — and run `aircloud test prepare` (npm test's pretest) so the release's
entries are compiled where `invoke` reads them. A test that signed an end user in to call a public route
now calls it without one; an owned or shared entity's route belongs inside `[authenticate]`.

## System tests

`@aircloudhq/testing/system` is what a product's system layer (`test/system/`, Playwright) imports:

```ts
// test/system/pet.spec.ts
import { expect, signInAs, test } from "@aircloudhq/testing/system";

test("staff opens the new pet dialog", async ({ context, page }) => {
  await signInAs(context, "staff");
  await page.goto("/pet/");
  await page.getByRole("button", { name: "New pet" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
```

- **`test` is the guarded test.** It is Playwright's `test` with its browser context guarded by the
  product's Content-Security-Policy: every page and every interaction of every test is checked, and
  the test fails on any violation, naming the directive, the blocked URI and the page. A violation
  raised by an interaction — opening a dialog, showing a toast — fails the test that performed it,
  and violations survive navigation: a new document or a second page is guarded like the first. Nothing
  in the spec calls a check; there is no interaction it can forget.
- **`expect`** is Playwright's, re-exported so a spec has one import.
- **`signInAs(context, principal)`** signs the context in as a principal `test/principals.toml`
  declares, with the session the release's verification run redeemed for it; outside a verification run
  it refuses by name.

`@playwright/test` is a peer dependency, at the version the platform's test-runner image carries the
browsers of; a product created with `aircloud new` already pins it in `test/package.json`.

## Install

A product created with `aircloud new` already carries it in `test/package.json`, at the version the
platform builds and tests with. By hand:

```sh
npm install --save-dev @aircloudhq/testing
```

It needs the Node.js release its `engines` field names (the platform's pinned line). Run a product's unit layer from `test/` with `npm run test:unit`, and one function's tests with

```sh
node --import @aircloudhq/testing/register --test "functions/<name>/**/*.test.js"
```

(`--test` takes files or globs; a directory argument is not run.)

## Documentation

How the test layers map to Rails' `test/` — unit, integration and system, and where each kind of test
lives — is section 15 ("Railties — test layers") of the *Rails to Air-Cloud* reference in the
Air-Cloud documentation. Questions and bug reports go to this package's issue tracker (the `bugs`
link on its npm page).

## License

MIT
