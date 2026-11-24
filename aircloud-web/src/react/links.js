// LinkTo and ButtonTo: link_to / button_to as components. The URL goes through urlFor, so the
// current page's `locale` parameter travels with every link (ADR-223 D7).
import { createElement as h, useMemo } from 'react';
import { Link, useInRouterContext, useLocation, useNavigate, useResolvedPath } from 'react-router';
import { api } from '../api.js';
import { IDEMPOTENCY_KEY_HEADER, submissionKeys } from '../resource.js';
import { urlFor } from '../helpers/url.js';

function useHere() {
  const inRouter = useInRouterContext();
  const loc = inRouter ? useLocation() : null; // stable per tree position: the router context never appears or vanishes under a mounted component
  if (loc) return `http://x${loc.pathname}${loc.search}${loc.hash}`;
  return typeof location !== 'undefined' ? location.href : undefined;
}

// A relative target resolves against the route hierarchy (React Router's rule), then gains the locale.
function useTarget(to) {
  const here = useHere();
  const inRouter = useInRouterContext();
  const resolved = inRouter ? useResolvedPath(to) : null; // stable per tree position (see useHere)
  const path = resolved ? `${resolved.pathname}${resolved.search}${resolved.hash}` : to;
  return urlFor(path, { currentUrl: here });
}

/** <LinkTo to="/profiles/1">Profile</LinkTo> — link_to "Profile", "/profiles/1" */
export function LinkTo({ to, children, ...props }) {
  const href = useTarget(to);
  if (useInRouterContext()) return h(Link, { to: href, ...props }, children ?? href);
  return h('a', { href, ...props }, children ?? href);
}

/**
 * <ButtonTo to="/api/pets/1" method="delete" onDone={…}>Delete</ButtonTo> — button_to: a one-button
 * form. `get` navigates; any other method calls the API (with `params` as the body) and hands the
 * result to `onDone`, or `onError` the ApiError.
 */
export function ButtonTo({ to, method = 'post', params, onDone, onError, children, className, formClass = 'button_to', ...props }) {
  const inRouter = useInRouterContext();
  const navigate = inRouter ? useNavigate() : null; // stable per tree position: the router context never appears or vanishes under a mounted component
  const action = useTarget(to);
  const m = String(method).toLowerCase();
  // A mutation names its effect with an Idempotency-Key (ADR-302 decision 8): one per press, reused when the same
  // press is retried after a failure, a new one after it succeeded.
  const keys = useMemo(() => submissionKeys(), [action, m]);
  function onSubmit(event) {
    event.preventDefault();
    if (m === 'get') {
      if (navigate) navigate(action);
      else location.assign(action);
      return;
    }
    const headers = { [IDEMPOTENCY_KEY_HEADER]: keys.keyFor({ action, m, params }) };
    api(m.toUpperCase(), action, params, { headers }).then(
      (r) => {
        keys.succeeded();
        onDone?.(r);
      },
      (e) => (onError ? onError(e) : undefined),
    );
  }
  return h(
    'form',
    { className: formClass, method: m === 'get' ? 'get' : 'post', action, onSubmit },
    ['patch', 'put', 'delete'].includes(m) ? h('input', { type: 'hidden', name: '_method', value: m, autoComplete: 'off' }) : null,
    h('button', { type: 'submit', className, ...props }, children),
  );
}
