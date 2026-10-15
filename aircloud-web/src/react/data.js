// Data hooks over a resource's CRUD route (#664 item 15): the React side of `@aircloudhq/web/resource`, for
// pages that are not a whole resourcePage. A resource is its entity name (resolved in the site's resource
// projection) or the projection resource itself.
//
//   const { records, cursor, loading, error, more, reload } = useList("pet", { filter: { owner: id } });
//   const { record, loading, error, reload } = useRecord("pet", id);
//
// The typed per-entity client is Air-Reflect's typed SDK (#246, ADR-083); these hooks read the projection.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createResource, projectionResource, recordLabel } from '../resource.js';
import { useSite } from './router.js';

/** The projection resource a hook names: an entity name, the resource itself, or null (no resource). */
export function useResource(resource) {
  const { projection } = useSite();
  if (resource === null || resource === undefined) return null;
  return typeof resource === 'string' ? projectionResource(projection, resource) : resource;
}

/**
 * The records of a resource, page by page (`cursor` paging; `more()` appends the next page).
 * @param {string|object|null} resource  null lists nothing
 * @param {{filter?: Record<string, string>, limit?: number}} [query]  `filter` compares fields by equality
 */
export function useList(resource, query = {}) {
  const r = useResource(resource);
  const client = useMemo(() => (r ? createResource(r) : null), [r]);
  const key = JSON.stringify({ filter: query.filter ?? {}, limit: query.limit ?? null });
  const [state, setState] = useState({ records: [], cursor: null, loading: Boolean(client), error: null });
  const generation = useRef(0);
  const load = useCallback(
    (after) => {
      if (!client) return Promise.resolve();
      const g = generation.current;
      const { filter, limit } = JSON.parse(key);
      setState((s) => ({ ...s, loading: true }));
      return client.list({ cursor: after ?? undefined, filter, limit: limit ?? undefined }).then(
        (page) => {
          if (g !== generation.current) return;
          setState((s) => ({ records: after ? s.records.concat(page.records) : page.records, cursor: page.cursor, loading: false, error: null }));
        },
        (error) => {
          if (g !== generation.current) return;
          setState((s) => ({ ...s, loading: false, error }));
        },
      );
    },
    [client, key],
  );
  useEffect(() => {
    generation.current += 1;
    setState({ records: [], cursor: null, loading: Boolean(client), error: null });
    load(null);
  }, [load]);
  return {
    ...state,
    /** The next page appended; a no-op on the last page. */
    more: () => (state.cursor ? load(state.cursor) : Promise.resolve()),
    /** The first page again. */
    reload: () => load(null),
  };
}

/**
 * One record of a resource by id; an undefined id reads nothing (`record` null).
 * @param {string|object} resource
 * @param {string|undefined} id
 */
export function useRecord(resource, id) {
  const r = useResource(resource);
  const client = useMemo(() => createResource(r), [r]);
  const [state, setState] = useState({ record: null, loading: id !== undefined, error: null });
  const generation = useRef(0);
  const load = useCallback(() => {
    if (id === undefined) return Promise.resolve();
    const g = generation.current;
    setState((s) => ({ ...s, loading: true }));
    return client.get(id).then(
      (record) => g === generation.current && setState({ record, loading: false, error: null }),
      (error) => g === generation.current && setState({ record: null, loading: false, error }),
    );
  }, [client, id]);
  useEffect(() => {
    generation.current += 1;
    setState({ record: null, loading: id !== undefined, error: null });
    load();
  }, [load]);
  return { ...state, reload: load };
}

/**
 * The labels of the related records the given records point to, one read per distinct related record:
 * `(field, id) => label | undefined` (undefined until read, or when the target is not routed).
 */
export function useRelationLabels(resource, records) {
  const { projection } = useSite();
  const wanted = useMemo(() => {
    const out = [];
    for (const f of resource.fields) {
      const target = f.relation ? projection?.resources?.[f.relation.target] : undefined;
      if (!target?.route_prefix) continue;
      const ids = new Set(records.map((rec) => rec?.data?.[f.name]).filter((v) => v !== undefined && v !== null && v !== ''));
      for (const id of ids) out.push({ target, id: String(id) });
    }
    return out;
  }, [resource, records, projection]);
  const [labels, setLabels] = useState({});
  const requested = useRef(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    for (const { target, id } of wanted) {
      const k = `${target.entity}/${id}`;
      if (requested.current.has(k)) continue;
      requested.current.add(k);
      const settle = (label) => mounted.current && setLabels((m) => ({ ...m, [k]: label }));
      createResource(target)
        .get(id)
        .then((rec) => settle(recordLabel(target, rec)), () => settle(null));
    }
  }, [wanted]);
  return (field, id) => {
    const f = resource.fields.find((x) => x.name === field);
    const target = f?.relation?.target;
    const label = target === undefined ? undefined : labels[`${target}/${id}`];
    return label ?? undefined;
  };
}

/**
 * The has-many relations of a resource: every relation field of a resource of the projection whose target
 * is it, in projection order — [{entity, field}].
 */
export function hasManyRelations(projection, name) {
  const out = [];
  for (const [entity, r] of Object.entries(projection?.resources ?? {})) {
    for (const f of r.fields) if (f.relation?.target === name) out.push({ entity, field: f.name });
  }
  return out;
}
