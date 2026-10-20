// @aircloudhq/web/csp-nonce — stamps the page's per-response CSP nonce on every <style> element a script
// creates, so a product site runs Radix and sonner under its declared style_src with no 'unsafe-inline'
// (#719, ADR-270 decision 7). A side effect: the generated main.jsx imports it FIRST, before any library
// module, and package.json lists it in `sideEffects` (a production build drops it otherwise).
//
//   import '@aircloudhq/web/csp-nonce';   // first import of the site entry
//
// Why a runtime stamp. The libraries do not read the nonce the page carries: get-nonce (react-style-singleton,
// hence Radix's scroll-lock) reads only setNonce() and the __webpack_nonce__ global, and sonner injects its
// <style> at module import with document.createElement('style') and no nonce at all. Both create the element
// with document.createElement, so stamping there covers them — and any future library that does the same —
// with no library change. One mechanism: no __webpack_nonce__ global is set beside it.
//
// The trust model. A <style> created by script inherits trust from the script that script_src admitted (the
// 'strict-dynamic' idea applied to styles). A <style> injected as markup (innerHTML, insertAdjacentHTML) is
// created by the parser, never passes through createElement, and stays blocked; so does a style attribute.
//
// Where the nonce comes from. Vite's html.cspNonce build emits <meta property="csp-nonce" nonce="…">, whose
// placeholder the platform replaces per response. Browsers hide the nonce content attribute after parsing
// but keep the `.nonce` IDL property, so it is read from the property, falling back to the attribute exactly
// as Vite's own runtime does. Without the meta (no policy nonce on this page) nothing is patched.

const XHTML = 'http://www.w3.org/1999/xhtml';
const PATCHED = Symbol.for('@aircloudhq/web/csp-nonce');

function readNonce() {
  if (typeof document === 'undefined') return undefined;
  const meta = document.querySelector('meta[property=csp-nonce]');
  if (!meta) return undefined;
  return meta.nonce || meta.getAttribute('nonce') || undefined;
}

const nonce = readNonce();

function stamp(element) {
  if (element.localName === 'style' && element.namespaceURI === XHTML) element.nonce = nonce;
  return element;
}

if (nonce !== undefined && !Document.prototype.createElement[PATCHED]) {
  const createElement = Document.prototype.createElement;
  const createElementNS = Document.prototype.createElementNS;
  const patchedCreateElement = function (...args) {
    return stamp(createElement.apply(this, args));
  };
  const patchedCreateElementNS = function (...args) {
    return stamp(createElementNS.apply(this, args));
  };
  patchedCreateElement[PATCHED] = true;
  patchedCreateElementNS[PATCHED] = true;
  Document.prototype.createElement = patchedCreateElement;
  Document.prototype.createElementNS = patchedCreateElementNS;
}

/**
 * The page's CSP nonce, read from Vite's <meta property="csp-nonce">, or undefined when the page has none.
 * @returns {string|undefined}
 */
export function cspNonce() {
  return nonce;
}
