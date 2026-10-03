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

A function answers in the caller's locale (`app/functions/pet/index.js`):

```js
import { i18nFor } from "@aircloudhq/web/function";

async function methodNotAllowed(request) {
  // functions.pet.errors.method_not_allowed, in the locale the request negotiates
  const i18n = await i18nFor(request, { function: "pet" });
  return Response.json({ error: { code: "method_not_allowed", message: i18n.t(".errors.method_not_allowed", { method: request.method }) } }, { status: 405 });
}
```

## Modules

| Import | What it carries |
|---|---|
| `@aircloudhq/web/react` | `SiteRouter`, `I18nProvider`, `useT`, `useSite`, `LinkTo`, `FormWith`, `resourcePage` |
| `@aircloudhq/web/helpers/number` | `numberToCurrency`, `numberToPercentage`, `numberWithDelimiter`, … |
| `@aircloudhq/web/helpers/date` | `timeAgoInWords`, `distanceOfTimeInWords`, `distanceOfTimeInWordsToNow` |
| `@aircloudhq/web/helpers/text`, `…/tag`, `…/url`, `…/form`, `…/sanitize`, `…/navigation` | the Action View helper modules of the same name |
| `@aircloudhq/web/helpers/translation` | `t` and `l` |
| `@aircloudhq/web/i18n` | `createI18n`, the runtime of the locale bundle |
| `@aircloudhq/web/model` | `modelName` and the model naming helpers |
| `@aircloudhq/web/function` | `i18nFor`, for functions |

## Documentation

The full Rails-to-Air-Cloud map — every Action View helper and where it lives here — is the
*Rails to Air-Cloud* reference in the Air-Cloud documentation. Its tests in a product run with
`@aircloudhq/testing`. Questions and bug reports go to this package's issue tracker (the `bugs` link
on its npm page).

## License

MIT
