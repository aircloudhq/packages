// ActionView::Helpers::NavigationHelper at the census commit (link_to, button_to, current_page?,
// link_to_unless_current, link_to_unless, link_to_if). The tag helpers return markup; every URL goes
// through urlFor, so the current page's `locale` parameter is carried forward (ADR-223 D7). There is
// no authenticity token: a product site is a static SPA and its writes go to functions.
import { escapeHtml } from '../i18n/index.js';
import { htmlAttributes, urlFor } from './url.js';

const METHOD_VERBS = ['patch', 'put', 'delete'];

/** link_to "Profile", "/profiles/1" # => <a href="/profiles/1">Profile</a> */
export function linkTo(name, url, htmlOptions = {}) {
  const { currentUrl, ...html } = htmlOptions;
  const href = urlFor(url, { currentUrl });
  return `<a${htmlAttributes({ ...html, href })}>${escapeHtml(name ?? href)}</a>`;
}

/**
 * button_to "New", "/articles/new", method: :get
 * # => <form class="button_to" method="get" action="/articles/new"><button type="submit">New</button></form>
 */
export function buttonTo(name, url, htmlOptions = {}) {
  const { method: m, params, form, formClass, form_class, currentUrl, ...html } = htmlOptions;
  const method = String(m ?? 'post').toLowerCase();
  const action = urlFor(url, { currentUrl });
  const formMethod = method === 'get' ? 'get' : 'post';
  const formAttrs = { class: form?.class ?? formClass ?? form_class ?? 'button_to', ...(form ?? {}), method: formMethod, action };
  const methodTag = METHOD_VERBS.includes(method)
    ? `<input type="hidden" name="_method" value="${method}" autocomplete="off" />`
    : '';
  const button = `<button${htmlAttributes({ ...html, type: 'submit' })}>${escapeHtml(name ?? action)}</button>`;
  const hidden = Object.entries(params ?? {})
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" autocomplete="off" />`)
    .join('');
  return `<form${htmlAttributes(formAttrs)}>${methodTag}${button}${hidden}</form>`;
}

const trimSlash = (s) => (s.length > 1 ? s.replace(/\/+$/, '') : s);

/**
 * current_page?("/shop/checkout") — the URL names the current page: its path (and, when the URL has
 * a query or `checkParameters` is set, its query) equals the current request's.
 */
export function currentPage(url, options = {}) {
  const here = options.currentUrl
    ? new URL(String(options.currentUrl), 'http://x')
    : typeof location !== 'undefined'
      ? new URL(location.href)
      : undefined;
  if (!here) throw new Error('currentPage: no current URL');
  const target = new URL(urlFor(url, { currentUrl: here.href, carryLocale: false }), here.href);
  const withQuery = String(typeof url === 'string' ? url : url?.path ?? '').includes('?') || options.checkParameters;
  const a = decodeURIComponent(trimSlash(target.pathname) + (withQuery ? target.search : ''));
  const b = decodeURIComponent(trimSlash(here.pathname) + (withQuery ? here.search : ''));
  return a === b;
}

/** link_to_unless_current("Home", "/") — the name alone on the current page, else the link. */
export function linkToUnlessCurrent(name, url, htmlOptions = {}) {
  return linkToUnless(currentPage(url, { currentUrl: htmlOptions.currentUrl }), name, url, htmlOptions);
}

/** link_to_unless(condition, "Reply", "/reply") — the name alone when the condition holds. */
export function linkToUnless(condition, name, url, htmlOptions = {}) {
  return condition ? escapeHtml(name) : linkTo(name, url, htmlOptions);
}

/** link_to_if(condition, "Login", "/login") — the link when the condition holds, else the name. */
export function linkToIf(condition, name, url, htmlOptions = {}) {
  return linkToUnless(!condition, name, url, htmlOptions);
}
