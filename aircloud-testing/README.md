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
  const res = await invoke("app/functions/pets/index.js",
    new Request("https://x/api/pets", { method: "POST", body: JSON.stringify({ name: "rex" }) }));
  assert.equal(res.status, 201);
  assert.equal(world.flex.records("pet").length, 1);
});
```

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
