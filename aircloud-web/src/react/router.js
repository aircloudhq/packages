// The router wrapper over React Router (a pinned lockfile dependency — never copied source) and the
// layouts (Rails `layouts/application`). A site's src/routes.js declares its named routes:
//
//   export default [{ name: "membros", path: "/membros/*", page: "membros", Component: MembrosPage }]
//
// and src/main.jsx renders <SiteRouter routes={routes} layouts={layouts} projection={projection} />.
// Each page renders inside its layout and its lazy-lookup scope (`t(".title")` in
// pages/membros/index.jsx is `membros.index.title`).
import { createContext, createElement as h, useContext } from 'react';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router';
import { PageScope } from './i18n.js';

const SiteContext = createContext({ layouts: {}, projection: null });

/** The layouts and the resource projection the site renders with. */
export function useSite() {
  return useContext(SiteContext);
}

/** A named layout (default `application`); `site.layout_missing` when absent. */
export function Layout({ name = 'application', children }) {
  const { layouts } = useSite();
  const L = layouts?.[name];
  if (!L) throw new Error(`layout "${name}" does not exist (src/layouts/${name}.jsx)`);
  return h(L, null, children);
}

/**
 * @param {{routes: Array<{name: string, path: string, page: string, Component: any, layout?: string}>,
 *          layouts?: Record<string, any>, projection?: object, basename?: string, initialEntries?: string[]}} props
 *   `initialEntries` renders over a memory history (tests and previews).
 */
export function SiteRouter({ routes, layouts = {}, projection = null, basename, initialEntries }) {
  const children = routes.map((r) =>
    h(Route, {
      key: r.name,
      path: r.path,
      element: h(Layout, { name: r.layout ?? r.Component.layout ?? 'application' }, h(PageScope, { page: r.page ?? r.name }, h(r.Component))),
    }),
  );
  const table = h(Routes, null, children);
  const router = initialEntries ? h(MemoryRouter, { initialEntries, basename }, table) : h(BrowserRouter, { basename }, table);
  return h(SiteContext.Provider, { value: { layouts, projection } }, router);
}
