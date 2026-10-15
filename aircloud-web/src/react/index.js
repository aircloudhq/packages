// @aircloudhq/web/react — the React bindings (ADR-222 D3; spec S4 § @aircloudhq/web public modules).
export { I18nProvider, PageScope, useI18n, useT } from './i18n.js';
export { Layout, SiteRouter, useSite } from './router.js';
// The router primitives of the one React Router instance the SiteRouter renders with (#664 item 13): a site
// imports them from here, never from `react-router` itself — a second copy would break the router context.
export {
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';
export { ButtonTo, LinkTo } from './links.js';
export {
  BooleanField,
  DateField,
  DateTimeField,
  DecimalField,
  EnumField,
  ErrorMessages,
  FileField,
  FormWith,
  IntegerField,
  JsonField,
  RelationField,
  TextField,
  VectorField,
  fieldFor,
  useForm,
} from './form.js';
export { Resource, ResourceForm, ResourceList, ResourceShow, ResourceTabs, defaultColumns, resourcePage, useDisplay } from './resource.js';
export { hasManyRelations, useList, useRecord } from './data.js';
