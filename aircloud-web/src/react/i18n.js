// I18nProvider: negotiates the page's locale (spec S4 § Locale negotiation — the `locale` parameter,
// the #632 preference hook, navigator.languages by RFC 4647 lookup, the default), binds the i18n
// instance the helpers render with, and wires the run-time missing-key reporter to
// POST /_air/i18n-missing (bounded per key per page load).
import { createContext, createElement as h, useContext, useMemo } from 'react';
import { createI18n, createMissingReporter, negotiateLocale } from '../i18n/index.js';
import { setCurrentI18n } from '../i18n/current.js';

const I18nContext = createContext(null);

/**
 * @param {{bundle: object, release?: string, locale?: string, url?: string, languages?: string[],
 *          preferred?: () => string|undefined, reporter?: (key: string) => void, children?: any}} props
 */
export function I18nProvider({ bundle, release, locale, url, languages, preferred, reporter, children }) {
  const i18n = useMemo(() => {
    const chosen =
      locale ??
      negotiateLocale({
        url: url ?? (typeof location !== 'undefined' ? location.href : undefined),
        languages: languages ?? (typeof navigator !== 'undefined' ? navigator.languages : []),
        available: bundle.available_locales,
        defaultLocale: bundle.default_locale,
        preferred,
      });
    const report = reporter ?? (release ? createMissingReporter({ release, locale: chosen }) : undefined);
    const instance = createI18n({ bundle, locale: chosen, reporter: report });
    setCurrentI18n(instance);
    return instance;
  }, [bundle, release, locale, url, languages, preferred, reporter]);
  return h(I18nContext.Provider, { value: i18n }, children);
}

/** The i18n instance of the nearest provider (or page scope). */
export function useI18n() {
  const i = useContext(I18nContext);
  if (!i) throw new Error('useI18n: no I18nProvider above this component');
  return i;
}

/** `t` bound to the nearest provider — lazy keys resolve against the page's scope. */
export function useT() {
  const i = useI18n();
  return i.t;
}

/** Provide the lazy-lookup scope of a page (`pages/<route>/index.jsx` → `<route>.index`). */
export function PageScope({ page, children }) {
  const parent = useI18n();
  const scoped = useMemo(() => parent.withLazy({ site_page: `pages/${page}/index.jsx` }), [parent, page]);
  return h(I18nContext.Provider, { value: scoped }, children);
}
