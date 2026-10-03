// @aircloudhq/testing/hooks — the module hooks @aircloudhq/testing/register installs.
//
// RESOLVE. A JavaScript function imports its capabilities by the WIT interface id — `import { query }
// from "aircloud:capability/flex-query@1.0.0"`, or a function-runtime interface of the guest package,
// `import { bundle } from "aircloud:functions/i18n@1.0.0"` — which componentize-js links to the host at
// build time. Node cannot load that specifier, so under node:test it resolves to the generated in-memory
// binding for the same interface. Only what the guest world imports resolves, and only at the version
// the WIT declares; any other `aircloud:` specifier is refused by name, because a test that silently
// loaded something else would be testing a function the platform would not build.
//
// PER-INVOCATION INSTANTIATION. The functions host instantiates a function fresh for every
// invocation. `invoke()` marks the entry module's URL with `air-invocation=<n>`; the mark is carried
// to every module the guest imports by relative path, so the whole guest program — not just its
// entry — is evaluated anew per invocation, as its bundle is on the platform.
//
// LOAD. A guest is an ES module whatever package.json sits above it (the builder bundles it with
// esbuild as ESM), so a marked module always loads with format "module".
import { CONTRACT } from "./generated/contract-data.js";

const MARK = "air-invocation";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("aircloud:")) {
    const iface = CONTRACT.specifiers[specifier];
    if (!iface) {
      throw new Error(`@aircloudhq/testing: '${specifier}' is not an interface the guest world imports (${Object.keys(CONTRACT.specifiers).join(", ")})`);
    }
    return { url: new URL(`./generated/bindings/${iface}.js`, import.meta.url).href, shortCircuit: true };
  }
  const resolved = await nextResolve(specifier, context);
  const mark = context.parentURL && context.parentURL.startsWith("file:") ? new URL(context.parentURL).searchParams.get(MARK) : null;
  if (mark && resolved.url.startsWith("file:") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const u = new URL(resolved.url);
    u.searchParams.set(MARK, mark);
    return { ...resolved, url: u.href };
  }
  return resolved;
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:")) {
    const u = new URL(url);
    if (u.searchParams.has(MARK) && /\.m?js$/.test(u.pathname)) return nextLoad(url, { ...context, format: "module" });
  }
  return nextLoad(url, context);
}
