// ActiveModel::Naming and ActiveModel::Translation for a projection resource (spec S4 § @aircloudhq/web
// public modules): the `activemodel.*` key of the current locale (and its declared fallbacks) when it
// exists, else the projection's `display_name` — the default-locale name, whose one carrier is
// db/schema/. No inflector is involved (ADR-213 D2).
import { i18nFor } from './i18n/current.js';

function fieldOf(resource, name) {
  const f = resource.fields.find((x) => x.name === name);
  if (!f) throw new Error(`resource "${resource.entity}" has no field "${name}"`);
  return f;
}

/** Model.model_name.human — `modelName(resource).human({count})`. */
export function modelName(resource, options = {}) {
  const i18n = i18nFor(options);
  return {
    singular: resource.entity,
    param_key: resource.entity,
    route_key: resource.route_prefix,
    human({ count } = {}) {
      const v = i18n?.lookupDeclared(`activemodel.models.${resource.entity}`);
      if (typeof v === 'string') return v;
      if (v && typeof v === 'object') {
        const one = count === undefined || count === 1 || /^1(\.0+)?$/.test(String(count));
        const pick = one ? v.one ?? v.other : v.other ?? v.one;
        if (typeof pick === 'string') return pick;
      }
      return resource.display_name;
    },
  };
}

/**
 * Model.human_attribute_name(:field), and human_attribute_name("field.value") for an enum value (ADR-258
 * decision 7): the nested key `activemodel.attributes.<entity>/<field>.<value>`, else the value's
 * projection display_name (the default-locale label), else the value itself — a value the projection
 * does not know renders as itself.
 */
export function humanAttributeName(resource, field, options = {}) {
  const dot = field.indexOf('.');
  if (dot >= 0) {
    const name = field.slice(0, dot);
    const value = field.slice(dot + 1);
    const f = fieldOf(resource, name);
    const v = i18nFor(options)?.lookupDeclared(`activemodel.attributes.${resource.entity}/${name}.${value}`);
    if (typeof v === 'string') return v;
    return f.enum?.values?.find((x) => x.value === value)?.display_name ?? value;
  }
  const f = fieldOf(resource, field);
  const v = i18nFor(options)?.lookupDeclared(`activemodel.attributes.${resource.entity}.${field}`);
  return typeof v === 'string' ? v : f.display_name;
}
