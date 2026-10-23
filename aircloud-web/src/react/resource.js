// Resource pages (ADR-222 D5; spec S4 § Resource-page override points): a scaffold page is one line —
// `export default resourcePage("pet")` — and the full CRUD interface comes from the resource projection.
// The Builder's choices are overrides in the page:
//
//   listColumns: string[]                        fields in the list, in order (default: the label field,
//                                                then the next fields in schema order, up to five)
//   fields: {[field]: Component}                 the input component of one field in the form
//   display: {[field]: (value, record) => node}  how one field shows in list and show views
//   List, Show, Form                             replace a whole view (props: resource, Default, …)
//   layout: string                               a layout other than `application`
//   tabs: string[]                               the show view's has-many tabs, one per relation of
//                                                another resource that targets this one: "<entity>", or
//                                                "<entity>.<field>" when that entity relates through
//                                                more than one field
//
// Every visible string is a translation (the human model and attribute names, helpers.resource.*,
// helpers.submit.*); a value renders through `l` and the number helpers of the current locale, a relation
// by the related record's label field.
import { createElement as h, useMemo, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router';
import { createResource, recordLabel } from '../resource.js';
import { humanAttributeName, modelName } from '../model.js';
import { useI18n } from './i18n.js';
import { useSite } from './router.js';
import { ErrorMessages, FormWith } from './form.js';
import { ButtonTo, LinkTo } from './links.js';
import { hasManyRelations, useList, useRecord, useRelationLabels } from './data.js';

/** The listColumns default (spec S4 § Constants, Provisional): label field first, up to five. */
export const LIST_COLUMNS_MAX = 5;

export function defaultColumns(resource) {
  const names = resource.fields.map((f) => f.name);
  const first = resource.label_field && names.includes(resource.label_field) ? [resource.label_field] : [];
  return [...first, ...names.filter((n) => !first.includes(n))].slice(0, LIST_COLUMNS_MAX);
}

/**
 * A stored value as the current locale renders it; a relation as `relationLabel(field, id)` gives it (the
 * related record's label, useRelationLabels), else its id.
 */
export function useDisplay(resource, display = {}, relationLabel = () => undefined) {
  const i18n = useI18n();
  return (field, record) => {
    const value = record?.data?.[field];
    if (display[field]) return display[field](value, record);
    if (value === undefined || value === null || value === '') return '';
    const type = resource.fields.find((f) => f.name === field)?.type;
    switch (type) {
      case 'date':
        return i18n.l(String(value));
      case 'datetime':
        return i18n.l(new Date(value));
      case 'integer':
      case 'decimal':
        return i18n.formatNumber('delimited', value);
      case 'boolean':
        return i18n.t(`helpers.resource.boolean.${value ? 'true' : 'false'}`);
      case 'relation':
        return relationLabel(field, String(value)) ?? String(value);
      case 'enum':
        return humanAttributeName(resource, `${field}.${value}`, { i18n });
      case 'json':
      case 'vector':
      case 'file':
        return JSON.stringify(value);
      default:
        return String(value);
    }
  };
}

/** A line break inside a text value: CR LF, or any Unicode mandatory break (UAX #14 BK, CR, LF, NL). */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;

/**
 * The list and show views' cell: `show`'s rendering, with an enum value wrapped in a badge (ADR-258
 * decision 10) — class `badge` plus `data-field` and `data-value`, the stable hooks a product's CSS styles
 * each value by — and a text value's lines kept (ADR-283 decision 4): each break a <br>, as Rails'
 * simple_format renders one, the value always text and never markup. A `display` override renders as given.
 */
function badged(resource, display = {}, show) {
  return (field, record) => {
    const node = show(field, record);
    const value = record?.data?.[field];
    if (display[field] || value === undefined || value === null || value === '') return node;
    const type = resource.fields.find((f) => f.name === field)?.type;
    if (type === 'text') {
      const lines = String(value).split(LINE_BREAK);
      return h('span', { 'data-field': field }, lines.flatMap((l, i) => (i === 0 ? [l] : [h('br', { key: i }), l])));
    }
    if (type !== 'enum') return node;
    return h('span', { className: 'badge', 'data-field': field, 'data-value': String(value) }, node);
  };
}

function useResourceOf(name) {
  const { projection } = useSite();
  const r = projection?.resources?.[name];
  if (!r) throw new Error(`the resource projection has no resource "${name}"`);
  return r;
}

/**
 * The default list view. `filter` lists only the records whose fields equal it (a has-many tab); `base`
 * null renders the rows without links to their pages (the related resource's pages are not mounted here).
 */
export function ResourceList({ resource, listColumns, display, base = '.', filter }) {
  const i18n = useI18n();
  const { records, cursor, error, more } = useList(resource, { filter });
  const show = badged(resource, display, useDisplay(resource, display, useRelationLabels(resource, records)));
  const columns = listColumns ?? defaultColumns(resource);
  const model = modelName(resource, { i18n });
  const first = (r, c) => {
    const label = show(c, r) || recordLabel(resource, r);
    return base === null ? label : h(LinkTo, { to: `${base}/${encodeURIComponent(r.id)}` }, label);
  };
  return h(
    'section',
    { className: 'resource-list' },
    base === null ? null : h('h1', null, model.human({ count: 2 })),
    h(ErrorMessages, { error }),
    base === null ? null : h('p', null, h(LinkTo, { to: `${base}/new`, className: 'button' }, i18n.t('helpers.resource.new', { model: model.human() }))),
    h(
      'table',
      null,
      h('thead', null, h('tr', null, columns.map((c) => h('th', { key: c }, humanAttributeName(resource, c, { i18n }))))),
      h(
        'tbody',
        null,
        records.map((r) =>
          h(
            'tr',
            { key: r.id },
            columns.map((c, i) => h('td', { key: c }, i === 0 ? first(r, c) : show(c, r))),
          ),
        ),
      ),
    ),
    cursor ? h('p', null, h('button', { type: 'button', onClick: () => more() }, i18n.t('helpers.resource.more'))) : null,
  );
}

/** The has-many relations a `tabs` option names, resolved against the projection — [{entity, field}]. */
export function resolveTabs(projection, resource, tabs = []) {
  const all = hasManyRelations(projection, resource.entity);
  return tabs.map((entry) => {
    const [entity, field] = String(entry).split('.');
    const matches = all.filter((r) => r.entity === entity && (field === undefined || r.field === field));
    if (matches.length === 0) throw new Error(`resource "${resource.entity}" has no has-many relation "${entry}"`);
    if (matches.length > 1) {
      throw new Error(
        `"${entity}" relates to "${resource.entity}" through more than one field (${matches.map((m) => `${m.entity}.${m.field}`).join(', ')}): name the tab "<entity>.<field>"`,
      );
    }
    return { ...matches[0], qualified: field !== undefined };
  });
}

/** The show view's has-many tabs: a tab per relation, its panel the related records of the shown one. */
export function ResourceTabs({ resource, id, tabs }) {
  const i18n = useI18n();
  const { projection } = useSite();
  const relations = useMemo(() => resolveTabs(projection, resource, tabs), [projection, resource, tabs]);
  const [active, setActive] = useState(0);
  if (relations.length === 0) return null;
  const label = (rel) => {
    const target = projection.resources[rel.entity];
    const name = modelName(target, { i18n }).human({ count: 2 });
    return rel.qualified ? `${name} (${humanAttributeName(target, rel.field, { i18n })})` : name;
  };
  const current = relations[Math.min(active, relations.length - 1)];
  return h(
    'section',
    { className: 'resource-tabs' },
    h(
      'nav',
      { role: 'tablist' },
      relations.map((rel, i) =>
        h('button', { key: `${rel.entity}.${rel.field}`, type: 'button', role: 'tab', 'aria-selected': String(rel === current), onClick: () => setActive(i) }, label(rel)),
      ),
    ),
    h(
      'div',
      { role: 'tabpanel' },
      h(ResourceList, { key: `${current.entity}.${current.field}`, resource: projection.resources[current.entity], filter: { [current.field]: id }, base: null }),
    ),
  );
}

/** The default show view (with `tabs`, the has-many tabs below the record). */
export function ResourceShow({ resource, display, id, base = '..', tabs }) {
  const i18n = useI18n();
  const navigate = useNavigate();
  const { record, error: readError } = useRecord(resource, id);
  const [actionError, setError] = useState(null);
  const error = actionError ?? readError;
  const records = useMemo(() => (record ? [record] : []), [record]);
  const show = badged(resource, display, useDisplay(resource, display, useRelationLabels(resource, records)));
  return h(
    'section',
    { className: 'resource-show' },
    h('h1', null, record ? recordLabel(resource, record) : modelName(resource, { i18n }).human()),
    h(ErrorMessages, { error }),
    record
      ? h(
          'dl',
          null,
          resource.fields.flatMap((f) => [
            h('dt', { key: `${f.name}-t` }, humanAttributeName(resource, f.name, { i18n })),
            h('dd', { key: `${f.name}-d` }, show(f.name, record)),
          ]),
        )
      : null,
    h(
      'div',
      { className: 'actions' },
      h(LinkTo, { to: `${base}/${encodeURIComponent(id)}/edit`, className: 'button' }, i18n.t('helpers.resource.edit')),
      h(
        ButtonTo,
        {
          to: `${resource.route_prefix}/${encodeURIComponent(id)}`,
          method: 'delete',
          onDone: () => navigate(base),
          onError: setError,
          className: 'button-danger',
        },
        i18n.t('helpers.resource.destroy'),
      ),
      h(LinkTo, { to: base }, i18n.t('helpers.resource.back')),
    ),
    tabs?.length ? h(ResourceTabs, { resource, id, tabs }) : null,
  );
}

/** The default form view (new when `id` is absent, edit otherwise); a relation is a select over its target. */
export function ResourceForm({ resource, fields, id, base = '..' }) {
  const i18n = useI18n();
  const navigate = useNavigate();
  const client = useMemo(() => createResource(resource), [resource]);
  const { record, error } = useRecord(resource, id);
  const model = modelName(resource, { i18n });
  if (id !== undefined && !record) return h(ErrorMessages, { error });
  return h(
    'section',
    { className: 'resource-form' },
    h('h1', null, id === undefined ? i18n.t('helpers.resource.new', { model: model.human() }) : `${i18n.t('helpers.resource.edit')} ${recordLabel(resource, record)}`),
    h(ErrorMessages, { error }),
    h(FormWith, {
      resource,
      record: record ?? undefined,
      fields,
      onSubmit: (payload) =>
        (id === undefined ? client.create(payload) : client.update(id, payload)).then((r) => {
          navigate(`${base}/${encodeURIComponent(r.id)}`);
          return r;
        }),
    }),
    h('p', null, h(LinkTo, { to: id === undefined ? base : `${base}/${encodeURIComponent(id)}` }, i18n.t('helpers.resource.cancel'))),
  );
}

function ShowRoute({ resource, options }) {
  const { id } = useParams();
  const View = options.Show ?? ResourceShow;
  return h(View, { resource, id, display: options.display, tabs: options.tabs, Default: ResourceShow, base: '..' });
}

function EditRoute({ resource, options }) {
  const { id } = useParams();
  const View = options.Form ?? ResourceForm;
  return h(View, { resource, id, fields: options.fields, Default: ResourceForm, base: '..' });
}

/** The routes of one resource: list, new, show, edit (Rails `resources`). */
export function Resource({ name, options = {} }) {
  const resource = useResourceOf(name);
  const List = options.List ?? ResourceList;
  const Form = options.Form ?? ResourceForm;
  return h(
    Routes,
    null,
    h(Route, { index: true, element: h(List, { resource, listColumns: options.listColumns, display: options.display, Default: ResourceList, base: '.' }) }),
    h(Route, { path: 'new', element: h(Form, { resource, fields: options.fields, Default: ResourceForm, base: '..' }) }),
    h(Route, { path: ':id', element: h(ShowRoute, { resource, options }) }),
    h(Route, { path: ':id/edit', element: h(EditRoute, { resource, options }) }),
  );
}

/** export default resourcePage("owner", { listColumns: ["name"], tabs: ["pet"] }) */
export function resourcePage(name, options = {}) {
  function ResourcePage() {
    return h(Resource, { name, options });
  }
  ResourcePage.displayName = `resourcePage(${name})`;
  // The router wrapper renders a page in `Component.layout` when its route names none.
  if (options.layout) ResourcePage.layout = options.layout;
  return ResourcePage;
}
