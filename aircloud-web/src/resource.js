// Framework-neutral resource operations over a resource's CRUD route (Rails `resources`): the route
// prefix, the fields and the label field come from the resource projection
// (contracts/deploy/v1/resource-projection-v1.json), never from a hand-kept field list.
//
//   GET <prefix>?cursor=&limit=   list   -> {records: [{id, data}], cursor}
//   GET <prefix>/<id>             get    -> {id, data}
//   POST <prefix>                 create -> {id, data}
//   PATCH <prefix>/<id>           update -> {id, data}
//   DELETE <prefix>/<id>          destroy
import { api as defaultApi } from './api.js';

/** The projection resource `name` of `projection` (a resource-projection-v1 document). */
export function projectionResource(projection, name) {
  const r = projection?.resources?.[name];
  if (!r) throw new Error(`the resource projection has no resource "${name}"`);
  return r;
}

/** A resource client. */
export function createResource(resource, options = {}) {
  const call = options.api ?? defaultApi;
  const prefix = resource.route_prefix;
  if (!prefix) throw new Error(`resource "${resource.entity}" has no route (site.resource_unrouted)`);
  const item = (id) => `${prefix}/${encodeURIComponent(id)}`;
  return {
    resource,
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
