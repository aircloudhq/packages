// @aircloudhq/testing — the function-runtime i18n interface (functions/src/caps_i18n.rs; #645,
// ADR-223 D3/D10).
//
// On the platform the host serves the locale bundle of the release the invocation resolved to. Under
// node:test there is no release, so the double serves the product's own compiled bundle: inside a
// product (a working directory at or below the directory holding `aircloud.toml`), every
// `world.reset()` loads `app/site/.aircloud/locale-bundle.json` — or, in an API-only product (no
// `app/site/`), `.aircloud/locale-bundle.json` at its root — the file `aircloud i18n bundle`
// writes, the one writer of it, which npm test's pretest and `aircloud test` run before the unit layer
// (#664 item 20; plan G13, R8/R22). A test may hand it another document with `world.i18n.use(bundle)`.
// With neither, `locales()` and `bundle()` refuse with `functions.locale_bundle_unresolvable`, exactly
// as the host refuses a release that records none, the message naming the command that writes the
// file: a function never silently translates from a default.
//
// The answers are the host's: `locales()` is the bundle header, `bundle(locale)` is the bundle
// restricted to the locale's run-time chain (itself, its declared fallbacks, the default locale, the
// platform `en` default) with every zone, and a locale outside `available_locales` is
// `functions.validation`. `keyMissing` records each key once (the host emits once per key per
// release per instance) on `world.i18n.missing`.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";

const HEADER_KEYS = ["version", "default_locale", "available_locales", "fallbacks", "time_zone", "data_versions"];
const PLATFORM_DEFAULT_LOCALE = "en";

function header(doc) {
  const out = {};
  for (const k of HEADER_KEYS) if (k in doc) out[k] = doc[k];
  return out;
}

/** The site directory of a product that has a site, relative to its root. */
export const PRODUCT_SITE_DIR = "app/site";
/**
 * The product's bundle file, relative to its root: under the site when the product has one (spec S4
 * § Site layout, skeleton.SiteBundleFile), else at the root for an API-only product. Literal mirrors of
 * the skeleton's constants (lane E2 adds the API-only one); the place is decided by whether app/site/
 * exists — the other path is never a fallback.
 */
export const PRODUCT_BUNDLE_FILE = "app/site/.aircloud/locale-bundle.json";
export const API_PRODUCT_BUNDLE_FILE = ".aircloud/locale-bundle.json";

/**
 * The product's compiled schema (#755 D15), relative to its root: beside the bundle, in the same derived
 * directory, placed by the same decision (skeleton.SchemaDeclarationFile; literal mirrors held equal by
 * functions.TestLocaleBundleFileIsTheDoublesPath). `aircloud test prepare` writes it; the release's tests
 * part mounts the release's own.
 */
export const PRODUCT_SCHEMA_FILE = "app/site/.aircloud/schema.json";
export const API_PRODUCT_SCHEMA_FILE = ".aircloud/schema.json";
/** The command that writes the compiled schema locally. */
export const PRODUCT_SCHEMA_WRITER = "aircloud test prepare";

/** The compiled-schema file a product at `root` reads, relative to it. */
export function productSchemaFile(root) {
  return existsSync(join(root, PRODUCT_SITE_DIR)) ? PRODUCT_SCHEMA_FILE : API_PRODUCT_SCHEMA_FILE;
}

/** The bundle file a product at `root` reads, relative to it. */
export function productBundleFile(root) {
  return existsSync(join(root, PRODUCT_SITE_DIR)) ? PRODUCT_BUNDLE_FILE : API_PRODUCT_BUNDLE_FILE;
}
/** The command that writes it — the one writer (R22). */
export const PRODUCT_BUNDLE_WRITER = "aircloud i18n bundle";

/** The product root at or above `dir` (the directory holding aircloud.toml), or null outside a product. */
export function productRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, "aircloud.toml"))) return d;
    if (dirname(d) === d) return null;
  }
}

function parseBundle(bundle, where) {
  const parsed = typeof bundle === "string" ? JSON.parse(bundle) : bundle;
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.available_locales)) {
    throw new DoubleMisuseError(`${where}: not a locale-bundle-v1 document`);
  }
  return parsed;
}

export function createI18nState() {
  let doc = null;
  let refusal = "no locale bundle — call world.i18n.use(bundle) with the bundle the function translates with";
  const root = productRoot(process.cwd());
  if (root !== null) {
    const rel = productBundleFile(root);
    const file = join(root, rel);
    if (existsSync(file)) doc = parseBundle(readFileSync(file, "utf8"), file);
    else refusal = `no locale bundle at ${rel} (a product with ${PRODUCT_SITE_DIR}/ reads ${PRODUCT_BUNDLE_FILE}, an API-only product ${API_PRODUCT_BUNDLE_FILE}) — run \`${PRODUCT_BUNDLE_WRITER}\` in the product (npm test's pretest and \`aircloud test\` run it), or call world.i18n.use(bundle)`;
  }
  const missing = [];
  const unresolvable = () => {
    throw new CapabilityFailure("functions.locale_bundle_unresolvable", refusal, { release_id: null });
  };
  return {
    /** Set the locale bundle (a locale-bundle-v1 document, as an object or its JSON text). */
    use(bundle) {
      doc = parseBundle(bundle, "i18n.use: the argument");
    },
    /** Every reported missing key, once each: { locale, key }. */
    get missing() { return missing; },
    locales() {
      if (!doc) unresolvable();
      return JSON.stringify(header(doc));
    },
    bundle(locale) {
      if (!doc) unresolvable();
      if (!doc.available_locales.includes(locale)) {
        throw new CapabilityFailure(
          "functions.validation",
          `locale ${JSON.stringify(locale)} is not one of the bundle's available_locales`,
          { locale, available_locales: doc.available_locales },
        );
      }
      const chain = [];
      const push = (l) => { if (!chain.includes(l)) chain.push(l); };
      push(locale);
      for (const l of (doc.fallbacks && doc.fallbacks[locale]) || []) push(l);
      push(doc.default_locale);
      push(PLATFORM_DEFAULT_LOCALE);
      const pick = (key) => {
        const out = {};
        for (const l of chain) if (doc[key] && l in doc[key]) out[l] = doc[key][l];
        return out;
      };
      // The product currency (ADR-255) rides along, its symbols restricted to the chain like messages
      // and cldr.
      const currency = doc.currency
        ? { ...doc.currency, symbols: Object.fromEntries(chain.filter((l) => doc.currency.symbols?.[l]).map((l) => [l, doc.currency.symbols[l]])) }
        : undefined;
      return JSON.stringify({ ...header(doc), messages: pick("messages"), cldr: pick("cldr"), zones: doc.zones, ...(currency ? { currency } : {}) });
    },
    keyMissing(locale, key) {
      if (!missing.some((m) => m.key === key)) missing.push({ locale, key });
    },
  };
}
