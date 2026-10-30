// Framework-neutral resource operations over a resource's CRUD route (Rails `resources`): the route
// prefix, the fields and the label field come from the resource projection
// (contracts/deploy/v1/resource-projection-v1.json), never from a hand-kept field list.
//
//   GET <prefix>?cursor=&limit=   list   -> {records: [{id, data}], cursor}
//   GET <prefix>/<id>             get    -> {id, data}
//   POST <prefix>                 create -> {id, data}
//   PATCH <prefix>/<id>           update -> {id, data}
//   DELETE <prefix>/<id>          destroy
//
// A page declares the ui.* surface it renders (#384 D82, D101): `createResource(resource, { surface })` sends
// it on every call as the `air-surface` header, which the web-origin validates and signs into the verified
// assertion Flex's field policy reads (`surface`). This client is the one place the declaration is written;
// the resource pages and data hooks choose the value by kind. It is presentation, never confidentiality:
// a client that declares nothing is the `api` surface, and Flex stays the enforcement.
import { api as defaultApi } from './api.js';

/**
 * The request header a page declares its surface on: outside the platform's x-air- namespace, which every
 * product route strips (web-origin `assertion::SURFACE_HEADER`).
 */
export const SURFACE_HEADER = 'air-surface';

/**
 * The surfaces a page may declare — the ui.* members of the grammar's policy_surface
 * (contracts/deploy/v1/skeleton-v1.json): a form or record view, and a table. `api`, `mcp` and `import`
 * are set by their own entries, never by a page.
 */
export const SURFACES = Object.freeze({ form: 'ui.form', table: 'ui.table' });

/**
 * The product host's field-schema read (#384 D104): `GET /_air/fields/{entity}` with the page's declared
 * surface answers `{fields: [{name, read_only}]}` — the fields of `entity` the session's selected
 * membership may see on that surface, and which of them it may not write. The web-origin admits the
 * session and relays the control plane's Reflect render against Flex as the end user.
 */
export const FIELDS_PATH = '/_air/fields';

/**
 * Read which fields of `entity` the session shows and enables on `surface` (one of SURFACES).
 * @returns {Promise<{fields: Array<{name: string, read_only: boolean}>}>}
 */
export function fieldSchema(entity, surface, options = {}) {
  if (!Object.values(SURFACES).includes(surface)) {
    throw new Error(`a field schema is read for the surface ${Object.values(SURFACES).join(' or ')}, not ${JSON.stringify(surface)}`);
  }
  const headers = { ...(options.headers ?? {}), [SURFACE_HEADER]: surface };
  return (options.api ?? defaultApi)('GET', `${FIELDS_PATH}/${encodeURIComponent(entity)}`, undefined, { ...options, headers });
}

/**
 * `resource` as a field schema lets a page render it: only the fields the schema lists, in projection
 * order, each carrying `read_only`. A `null` schema (none could be read) leaves the resource as the
 * projection gives it. Presentation only: Flex keeps enforcing every read and write.
 */
export function applyFieldSchema(resource, schema) {
  if (!schema) return resource;
  const listed = new Map((schema.fields ?? []).map((f) => [f.name, Boolean(f.read_only)]));
  return {
    ...resource,
    fields: resource.fields.filter((f) => listed.has(f.name)).map((f) => ({ ...f, read_only: listed.get(f.name) })),
  };
}

/** The projection resource `name` of `projection` (a resource-projection-v1 document). */
export function projectionResource(projection, name) {
  const r = projection?.resources?.[name];
  if (!r) throw new Error(`the resource projection has no resource "${name}"`);
  return r;
}

/**
 * A resource client. `surface` (one of SURFACES) is declared on every call; none declares nothing.
 * @param {object} resource  a projection resource
 * @param {{api?: Function, surface?: string}} [options]
 */
export function createResource(resource, options = {}) {
  const api = options.api ?? defaultApi;
  const prefix = resource.route_prefix;
  if (!prefix) throw new Error(`resource "${resource.entity}" has no route (site.resource_unrouted)`);
  const { surface } = options;
  if (surface !== undefined && !Object.values(SURFACES).includes(surface)) {
    throw new Error(`a page declares the surface ${Object.values(SURFACES).join(' or ')}, not ${JSON.stringify(surface)}`);
  }
  const declared = surface === undefined ? undefined : { headers: { [SURFACE_HEADER]: surface } };
  const call = (method, path, body) => (declared ? api(method, path, body, declared) : api(method, path, body));
  const item = (id) => `${prefix}/${encodeURIComponent(id)}`;
  return {
    resource,
    surface: surface ?? null,
    /** list({cursor, limit, filter: {field: value}}) -> {records, cursor} */
    list({ cursor, limit, filter } = {}) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(filter ?? {})) q.set(k, String(v));
      if (cursor) q.set('cursor', cursor);
      if (limit) q.set('limit', String(limit));
      const s = q.toString();
      return call('GET', s ? `${prefix}?${s}` : prefix).then((r) => ({ records: r?.records ?? [], cursor: r?.cursor ?? null }));
    },
    /** Every page, in order: for await (const page of pets.pages()) … */
    async *pages(params = {}) {
      let cursor = params.cursor ?? null;
      do {
        const page = await this.list({ ...params, cursor });
        yield page.records;
        cursor = page.cursor;
      } while (cursor);
    },
    get: (id) => call('GET', item(id)),
    create: (data) => call('POST', prefix, data),
    update: (id, data) => call('PATCH', item(id), data),
    destroy: (id) => call('DELETE', item(id)),
  };
}

/** A record's label: its label field's value, else its id. */
export function recordLabel(resource, record) {
  const f = resource.label_field;
  const v = f ? record?.data?.[f] : undefined;
  return v === undefined || v === null || v === '' ? String(record?.id ?? '') : String(v);
}
