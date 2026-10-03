// ActionView::Helpers::SanitizeHelper with Rails' safe-list sanitizer: the default allowlist and the
// URI rules are the vendored rails-html-sanitizer / Loofah data (sanitize-allowlist.js, generated).
// Parsing uses the browser's HTML parser (a <template>), so the tree scrubbed is the tree a browser
// would build. `sanitize` and `stripLinks` return markup; `stripTags` returns plain text (a React
// text child is escaped by React — census § 4, output safety adapted).
import { attributes as ALLOWED_ATTRIBUTES, dataMediaTypes, protocols, tags as ALLOWED_TAGS, uriAttributes } from './sanitize-allowlist.js';

function parse(html) {
  if (typeof document === 'undefined') throw new Error('sanitize: an HTML parser (document) is required');
  const t = document.createElement('template');
  t.innerHTML = String(html ?? '');
  return t;
}

// Loofah CONTROL_CHARACTERS and its protocol grammar.
const CONTROL = /[`\u0000- \u007F\s\u0080-ā]/g;
const PROTOCOL = /^[a-z][a-z0-9+\-.]*(?::|&#0*58|&#x0*3a|(?:%|&#37;)3a)/i;
const SEPARATOR = /:|&#0*58|&#x0*3a|(?:%|&#37;)3a/i;

/** Loofah::HTML5::Scrub.allowed_uri? over an attribute value the parser already decoded. */
export function allowedUri(value) {
  const v = String(value).replace(CONTROL, '').toLowerCase();
  if (!PROTOCOL.test(v)) return true;
  const protocol = v.split(SEPARATOR)[0];
  if (!protocols.includes(protocol)) return false;
  if (protocol === 'data') {
    const m = /^data:([^;,]*)/.exec(v);
    return Boolean(m) && dataMediaTypes.includes(m[1]);
  }
  return true;
}

function scrub(node, tags, attrs) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 3) continue; // text
    if (child.nodeType === 1) {
      scrub(child.content ?? child, tags, attrs); // bottom-up, as the PermitScrubber
      const name = child.localName;
      const foreign = child.namespaceURI && child.namespaceURI !== 'http://www.w3.org/1999/xhtml';
      if (!tags.has(name) || foreign) {
        // A foreign (svg/math) element is pruned with its content (namespace confusion); any other
        // disallowed element is replaced by its children.
        if (!foreign) child.replaceWith(...child.childNodes);
        else child.remove();
        continue;
      }
      for (const a of [...child.attributes]) {
        if (!attrs.has(a.name) || (uriAttributes.includes(a.name) && !allowedUri(a.value))) child.removeAttribute(a.name);
      }
      continue;
    }
    child.remove(); // comments, processing instructions
  }
}

/** sanitize(@article.body) — `tags` / `attributes` replace the default allowlist, as in Rails. */
export function sanitize(html, options = {}) {
  const t = parse(html);
  scrub(t.content, new Set(options.tags ?? ALLOWED_TAGS), new Set(options.attributes ?? ALLOWED_ATTRIBUTES));
  return t.innerHTML;
}

/** strip_tags("Strip <i>these</i> tags!") # => "Strip these tags!" */
export function stripTags(html) {
  return parse(html).content.textContent;
}

/** strip_links('<a href="http://www.rubyonrails.org">Ruby on Rails</a>') # => "Ruby on Rails" */
export function stripLinks(html) {
  const t = parse(html);
  for (const a of [...t.content.querySelectorAll('a')]) a.replaceWith(...a.childNodes);
  return t.innerHTML;
}
