// @aircloudhq/testing — the function-runtime i18n interface (functions/src/caps_i18n.rs; #645,
// ADR-223 D3/D10).
//
// On the platform the host serves the locale bundle of the release the invocation resolved to. Under
// node:test there is no release: the test hands the double the bundle its function should translate
// with — the product's compiled bundle (`app/site/.aircloud/`, which `aircloud check` refreshes) or a
// document of its own — with `world.i18n.use(bundle)`. Until it does, `locales()` and `bundle()`
// refuse with `functions.locale_bundle_unresolvable`, exactly as the host refuses a release that
// records none: a function never silently translates from a default.
//
// The answers are the host's: `locales()` is the bundle header, `bundle(locale)` is the bundle
// restricted to the locale's run-time chain (itself, its declared fallbacks, the default locale, the
// platform `en` default) with every zone, and a locale outside `available_locales` is
// `functions.validation`. `keyMissing` records each key once (the host emits once per key per
// release per instance) on `world.i18n.missing`.
import { CapabilityFailure, DoubleMisuseError } from "../errors.js";

const HEADER_KEYS = ["version", "default_locale", "available_locales", "fallbacks", "time_zone", "data_versions"];
const PLATFORM_DEFAULT_LOCALE = "en";

function header(doc) {
  const out = {};
  for (const k of HEADER_KEYS) if (k in doc) out[k] = doc[k];
  return out;
}

export function createI18nState() {
  let doc = null;
  const missing = [];
  const unresolvable = () => {
    throw new CapabilityFailure(
      "functions.locale_bundle_unresolvable",
      "no locale bundle — call world.i18n.use(bundle) with the bundle the function translates with",
      { release_id: null },
    );
  };
  return {
    /** Set the locale bundle (a locale-bundle-v1 document, as an object or its JSON text). */
    use(bundle) {
      const parsed = typeof bundle === "string" ? JSON.parse(bundle) : bundle;
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.available_locales)) {
        throw new DoubleMisuseError("i18n.use: the argument is not a locale-bundle-v1 document");
      }
      doc = parsed;
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
      return JSON.stringify({ ...header(doc), messages: pick("messages"), cldr: pick("cldr"), zones: doc.zones });
    },
    keyMissing(locale, key) {
      if (!missing.some((m) => m.key === key)) missing.push({ locale, key });
    },
  };
}
