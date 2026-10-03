// The i18n instance the helpers render with — Rails' I18n.locale, scoped to the page. The React
// I18nProvider binds it; a framework-neutral caller binds it with setCurrentI18n, or passes `i18n`
// in a helper's options.

let current = null;

export function setCurrentI18n(i18n) {
  current = i18n;
}

export function currentI18n() {
  return current;
}

/** The instance a helper call uses: its `i18n` option, else the bound one. */
export function i18nFor(options) {
  return options?.i18n ?? current;
}

/** Like i18nFor, but a helper that cannot render without translations refuses loudly. */
export function requireI18n(options, helper) {
  const i = i18nFor(options);
  if (!i) throw new Error(`${helper}: no i18n instance is bound (I18nProvider, setCurrentI18n, or the i18n option)`);
  return i;
}
