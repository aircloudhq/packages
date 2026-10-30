# @aircloudhq/web

The application package of an Air-Cloud product: what a product's site and its JavaScript functions
import to render pages, format values and speak the product's languages. It brings the Rails Action View
helpers to the browser and to functions, one module per Rails helper module, under the names a Rails
developer already knows (`numberToCurrency`, `timeAgoInWords`, `t`, `l`, and the `LinkTo` and
`FormWith` components).

- **Pages from your models.** `resourcePage("pet")` renders list, show, create, edit and delete for an
  entity from the resource projection the platform derives from `db/schema/pet.toml`. Adding a field to
  the schema changes the page with no edit to the view.
- **I18n.** Translations come from the locale bundle the platform compiles from `config/locales/`, with
  Rails' lazy lookup: `t(".title")` in `pages/home/index.jsx` reads `home.index.title`. Plurals, dates,
  numbers and currencies follow CLDR for every locale the product declares.
- **The same helpers in functions.** `@aircloudhq/web/function` gives a function the caller's locale,
  so its error messages answer in the language of the request.
- **React bindings.** `@aircloudhq/web/react` carries the router, layouts, links and form components.

A product created with `aircloud new` already depends on this package, at the version the platform
builds and tests with. You rarely add it by hand.

## Install

```sh
npm install @aircloudhq/web
```

It needs the Node.js release its `engines` field names (the platform's pinned line), and React 19.2.7 or later for
the React bindings.

## Usage

The site entry point `aircloud new` generates (`app/site/src/main.jsx`) renders the product's routes
inside its layouts, with the locale bundle and the resource projection:

```jsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, SiteRouter } from "@aircloudhq/web/react";
import bundle from "../.aircloud/locale-bundle.json";
import projection from "../.aircloud/resource-projection.json";
import routes from "./routes.js";

// Every src/layouts/<name>.jsx, by name (`application` is the default layout).
const layouts = Object.fromEntries(
  Object.entries(import.meta.glob("./layouts/*.jsx", { eager: true })).map(([file, module]) => [
    file.slice(file.lastIndexOf("/") + 1, -4),
    module.default,
  ]),
);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <I18nProvider bundle={bundle}>
      <SiteRouter routes={routes} layouts={layouts} projection={projection} />
    </I18nProvider>
  </StrictMode>,
);
```

A page reads its strings by lazy lookup (`app/site/src/pages/home/index.jsx`):

```jsx
import { useT } from "@aircloudhq/web/react";

export default function HomePage() {
  const t = useT();
  return (
    <section>
      <h1>{t(".title")}</h1>
      <p>{t(".intro")}</p>
    </section>
  );
}
```

The resource page `aircloud generate scaffold pet` writes is one line (`app/site/src/pages/pet/index.jsx`):

```jsx
import { resourcePage } from "@aircloudhq/web/react";

export default resourcePage("pet");
```

A resource page declares the surface it renders — `ui.table` for a list, `ui.form` for a record view or a
form — on the `air-surface` request header, so a field policy can tell a table from a form. The resource
client writes it (`createResource(resource, { surface: SURFACES.table })`); the pages and the data hooks
`useList` / `useRecord` pick it for you. It is presentation, never confidentiality: Flex decides every read
and write.

Which fields a resource page shows is the signed-in user's: each view reads its entity's field schema for its
surface once (`GET /_air/fields/<entity>`, `useFieldSchema(resource, surface)` in a page of your own) and
renders only the fields it lists — a field the user may see but not write is rendered disabled and never
sent. A page that cannot read it renders the projection's fields; Flex still decides every read and write.

Routing inside a page uses the router primitives `@aircloudhq/web/react` re-exports — `Link`, `NavLink`,
`Routes`, `Route`, `Outlet`, `Navigate`, `useLocation`, `useNavigate`, `useParams`, `useSearchParams` — the
same React Router instance the `SiteRouter` renders with. Import them from `@aircloudhq/web/react`, never from
`react-router`: a second copy of the router breaks its context.

Dates and times render through `l` (`useI18n().l`, or `l` from `@aircloudhq/web/helpers/translation`), never
`Intl`. A named format is looked up by what the value is:

- an **instant** — a `Date` or a timestamp — reads `time.formats.<name>` and renders in the product's time zone;
- a **civil date** — a `"YYYY-MM-DD"` string — reads `date.formats.<name>`.

So `l(new Date(), { format: "weekday" })` reads `time.formats.weekday`; for `date.formats.weekday` pass the civil
date (`l("2026-03-08", { format: "weekday" })`). A format no locale of the chain defines renders humanized and
is **reported**, like a missing key: with a `release`, to the product host; with none (a dev server, a preview),
`I18nProvider` warns on the console, naming the rule.

A function answers in the caller's locale (`app/functions/pet/index.js`):

```js
import { i18nFor } from "@aircloudhq/web/function";

async function methodNotAllowed(request) {
  // functions.pet.errors.method_not_allowed, in the locale the request negotiates
  const i18n = await i18nFor(request, { function: "pet" });
  return Response.json({ error: { code: "method_not_allowed", message: i18n.t(".errors.method_not_allowed", { method: request.method }) } }, { status: 405 });
}
```

Your org tree, from your site, with the signed-in end user's own session (`@aircloudhq/web/org`):

```js
import { memberships, members, orgNodes, profiles, workspaces, SESSION_MEMBERSHIP_REQUIRED } from "@aircloudhq/web/org";

const { memberships: mine, selected } = await memberships.list();   // the membership switcher
await memberships.select(mine[1].membership_id);                     // act through another, no new login
const { roles, grants } = await memberships.roles(selected, { node: "/acme/sales" }); // effective there
const ws = await workspaces.create({ displayName: "Acme" });         // {org_path, membership_id, selected}
const sales = (await profiles.list({ node: ws.org_path }))[0];
await members.invite({ email: "bia@example.com", orgPath: ws.org_path, profile: { orgPath: sales.org_path, name: sales.name } });
const { at, nodes, names } = await orgNodes.homes();                // where a member may be homed: at first
```

`members`, `profiles`, `groups`, `denies` and `orgNodes` reach the platform's `/_air/members` surface, and the
platform decides every answer at the caller's node; a refusal rejects with an `ApiError` carrying its code. A
node is a `node` argument, sent as the `node` query parameter. `orgNodes.homes()` answers the nodes a member may be
homed at — your acting node `at`, first, and the nodes below it that exist and are not archived — so a form offers
only those, with `names` — each offered node's display name by path, when it has one (an unnamed node shows its last path segment). `orgNodes.create({ orgPath, displayName })` names a new node and `orgNodes.rename(node, displayName)` renames one. `workspaces.create` answers `selected: false`
when the workspace was created but the session still acts through its previous membership: send the user to
the switcher, never retry (a retry creates a second workspace).

## Modules

| Import | What it carries |
|---|---|
| `@aircloudhq/web/react` | `SiteRouter`, `I18nProvider`, `useT`, `useSite`, `LinkTo`, `FormWith`, `resourcePage`, the data hooks `useList` / `useRecord`, and the router primitives (`Link`, `Routes`, `useParams`, …) |
| `@aircloudhq/web/helpers/number` | `numberToCurrency`, `numberToPercentage`, `numberWithDelimiter`, … |
| `@aircloudhq/web/helpers/date` | `timeAgoInWords`, `distanceOfTimeInWords`, `distanceOfTimeInWordsToNow` |
| `@aircloudhq/web/helpers/text`, `…/tag`, `…/url`, `…/form`, `…/sanitize`, `…/navigation` | the Action View helper modules of the same name |
| `@aircloudhq/web/helpers/translation` | `t` and `l` |
| `@aircloudhq/web/i18n` | `createI18n`, the runtime of the locale bundle |
| `@aircloudhq/web/model` | `modelName` and the model naming helpers |
| `@aircloudhq/web/resource` | `createResource`, `SURFACES`, `SURFACE_HEADER` |
| `@aircloudhq/web/org` | `memberships`, `members`, `profiles`, `groups`, `denies`, `orgNodes`, `workspaces` |
| `@aircloudhq/web/function` | `i18nFor`, for functions |
| `@aircloudhq/web/csp-nonce` | `cspNonce`; imported for its side effect, below |

## Content-Security-Policy nonce

```js
// app/site/src/main.jsx — the first import, before any library
import "@aircloudhq/web/csp-nonce";
```

A product's site runs under the product's declared Content-Security-Policy, and its default `style_src`
admits no inline style. The platform adds a fresh nonce to every page response — to the directives
`nonce_directives` lists in `config/content_security_policy.toml` (`["style_src"]` by default) and to the
page, where the site's Vite build left a placeholder (`html.cspNonce` in `vite.config.js`). The build stamps
the nonce on the tags it emits and on `<meta property="csp-nonce">`.

Component libraries create their own `<style>` elements from script — Radix (the scroll-lock of a Dialog)
and `sonner` (at import time) among them — and neither reads that meta. This module does: it stamps the
nonce on every `<style>` a script creates with `document.createElement` or `createElementNS`, so those
libraries run under the default policy with no `'unsafe-inline'`. A style created by script inherits the
trust of the script the policy admitted; a `<style>` injected as markup (`innerHTML`,
`insertAdjacentHTML`) or a `style` attribute stays blocked.

It must be the **first** import of the site entry: a library that injects its style when its module loads
has already created the element by the time a later import runs. `cspNonce()` returns the page's nonce
(or `undefined` on a page without one), for code that needs to pass it on. A site created with
`aircloud new` already imports it.

## Documentation

The full Rails-to-Air-Cloud map — every Action View helper and where it lives here — is the
*Rails to Air-Cloud* reference in the Air-Cloud documentation. Its tests in a product run with
`@aircloudhq/testing`. Questions and bug reports go to this package's issue tracker (the `bugs` link
on its npm page).

## License

MIT
