// ActionView::RecordIdentifier (dom_id, dom_class) and TagHelper#token_list. A record's class is its
// resource: the entity name is Rails' param_key (Flex names are already snake_case).

function paramKey(resource) {
  const name = typeof resource === 'string' ? resource : resource?.entity;
  if (!name) throw new TypeError('domClass: a resource (entity name or projection resource) is required');
  return name;
}

/** dom_class(post) # => "post"; dom_class(post, :edit) # => "edit_post" */
export function domClass(resource, prefix) {
  const key = paramKey(resource);
  return prefix ? `${prefix}_${key}` : key;
}

/** dom_id(Post.find(45)) # => "post_45"; dom_id(Post.new) # => "new_post" */
export function domId(resource, record, prefix) {
  const id = record?.id;
  if (id === undefined || id === null || id === '') return domClass(resource, prefix ?? 'new');
  return `${domClass(resource, prefix)}_${id}`;
}

/** token_list("foo", { bar: true, baz: false }) # => "foo bar" */
export function tokenList(...args) {
  const out = [];
  const add = (v) => {
    if (v === null || v === undefined || v === false || v === '') return;
    if (Array.isArray(v)) return v.forEach(add);
    if (typeof v === 'object') {
      for (const [k, on] of Object.entries(v)) if (on) add(k);
      return;
    }
    for (const t of String(v).split(/\s+/)) if (t && !out.includes(t)) out.push(t);
  };
  args.forEach(add);
  return out.join(' ');
}
