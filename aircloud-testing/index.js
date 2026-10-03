// @aircloudhq/testing — capability doubles for unit-testing Air-Cloud JavaScript functions.
//
//   import { world, invoke } from "@aircloudhq/testing";
//   beforeEach(() => world.reset());
//
// Run the tests with the resolution hook so a function's `aircloud:capability/*` imports load the
// doubles. From the product's test/: `npm run test:unit` runs every unit test, and one function's:
//   node --import @aircloudhq/testing/register --test "functions/<name>/**/*.test.js"
export { world } from "./src/world.js";
export { invoke } from "./src/harness.js";
export { ComponentError, DoubleMisuseError } from "./src/errors.js";
