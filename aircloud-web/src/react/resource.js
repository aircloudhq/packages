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
//
// Every visible string is a translation (the human model and attribute names, helpers.resource.*,
// helpers.submit.*); a value renders through `l` and the number helpers of the current locale.
import { createElement as h, useEffect, useMemo, useState } from 'react';
import { Route, Routes, useNavigate, useParams } from 'react-router';
import { createResource, recordLabel } from '../resource.js';
import { humanAttributeName, modelName } from '../model.js';
import { useI18n } from './i18n.js';
import { useSite } from './router.js';
import { ErrorMessages, FormWith } from './form.js';
import { ButtonTo, LinkTo } from './links.js';

/** The listColumns default (spec S4 § Constants, Provisional): label field first, up to five. */
export const LIST_COLUMNS_MAX = 5;

export function defaultColumns(resource) {
  const names = resource.fields.map((f) => f.name);
  const first = resource.label_field && names.includes(resource.label_field) ? [resource.label_field] : [];
  return [...first, ...names.filter((n) => !first.includes(n))].slice(0, LIST_COLUMNS_MAX);
}

/** A stored value as the current locale renders it. */
export function useDisplay(resource, display = {}) {
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
      case 'json':
      case 'vector':
        return JSON.stringify(value);
      default:
        return String(value);
    }
  };
}

function useResourceOf(name) {
  const { projection } = useSite();
  const r = projection?.resources?.[name];
  if (!r) throw new Error(`the resource projection has no resource "${name}"`);
  return r;
}

/** The default list view. */
export function ResourceList({ resource, listColumns, display, base = '.' }) {
  const i18n = useI18n();
  const client = useMemo(() => createResource(resource), [resource]);
  const [records, setRecords] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [error, setError] = useState(null);
  const show = useDisplay(resource, display);
  const columns = listColumns ?? defaultColumns(resource);
  const load = (after) =>
    client.list({ cursor: after ?? undefined }).then((page) => {
      setRecords((prev) => (after ? prev.concat(page.records) : page.records));
      setCursor(page.cursor);
    }, setError);
  useEffect(() => {
    load(null);
  }, [client]);
  const model = modelName(resource, { i18n });
  return h(
    'section',
    { className: 'resource-list' },
    h('h1', null, model.human({ count: 2 })),
    h(ErrorMessages, { error }),
    h('p', null, h(LinkTo, { to: `${base}/new`, className: 'button' }, i18n.t('helpers.resource.new', { model: model.human() }))),
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
            columns.map((c, i) =>
              h('td', { key: c }, i === 0 ? h(LinkTo, { to: `${base}/${encodeURIComponent(r.id)}` }, show(c, r) || recordLabel(resource, r)) : show(c, r)),
            ),
          ),
        ),
      ),
    ),
    cursor ? h('p', null, h('button', { type: 'button', onClick: () => load(cursor) }, i18n.t('helpers.resource.more'))) : null,
  );
}

/** The default show view. */
export function ResourceShow({ resource, display, id, base = '..' }) {
  const i18n = useI18n();
  const navigate = useNavigate();
  const client = useMemo(() => createResource(resource), [resource]);
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(null);
  const show = useDisplay(resource, display);
  useEffect(() => {
    client.get(id).then(setRecord, setError);
  }, [client, id]);
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
  );
}

/** The default form view (new when `id` is absent, edit otherwise). */
export function ResourceForm({ resource, fields, id, base = '..' }) {
  const i18n = useI18n();
  const navigate = useNavigate();
  const client = useMemo(() => createResource(resource), [resource]);
  const [record, setRecord] = useState(id === undefined ? null : undefined);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (id !== undefined) client.get(id).then(setRecord, setError);
  }, [client, id]);
  const model = modelName(resource, { i18n });
  if (record === undefined) return h(ErrorMessages, { error });
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
  return h(View, { resource, id, display: options.display, Default: ResourceShow, base: '..' });
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

/** export default resourcePage("pet", { listColumns: ["name", "species"] }) */
export function resourcePage(name, options = {}) {
  function ResourcePage() {
    return h(Resource, { name, options });
  }
  ResourcePage.displayName = `resourcePage(${name})`;
  // The router wrapper renders a page in `Component.layout` when its route names none.
  if (options.layout) ResourcePage.layout = options.layout;
  return ResourcePage;
}
