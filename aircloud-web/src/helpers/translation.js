// ActionView::Helpers::TranslationHelper: `t`/`translate` and `l`/`localize` over the bound i18n
// instance (the React I18nProvider binds it; the lazy scope of a page comes from the router wrapper
// or `resourcePage`). The semantics are the i18n runtime's (contracts/deploy/v1/i18n-vectors.json).
import { requireI18n } from '../i18n/current.js';

/** t("membros.index.title") — or t(".title") inside a page (lazy lookup). */
export function translate(key, options = {}) {
  return requireI18n(options, 'translate').t(key, stripI18n(options));
}

/** l(Date.today, format: :long) */
export function localize(value, options = {}) {
  return requireI18n(options, 'localize').l(value, stripI18n(options));
}

export const t = translate;
export const l = localize;

function stripI18n(options) {
  if (!options || !('i18n' in options)) return options;
  const { i18n, ...rest } = options;
  return rest;
}
