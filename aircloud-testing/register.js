// @aircloudhq/testing/register — make `aircloud:capability/*` imports load the in-memory doubles.
//
//   npm run test:unit                    (from the product's test/: every unit test)
//   node --import @aircloudhq/testing/register --test "functions/<name>/**/*.test.js"
//                                        (from test/: one function's tests — --test takes files or
//                                        globs, not a directory)
//
// Registering is the only side effect; the doubles themselves load on first import.
import { register } from "node:module";

register("./hooks.js", import.meta.url);
