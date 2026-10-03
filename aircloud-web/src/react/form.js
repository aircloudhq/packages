// FormWith (form_with over the framework-neutral form model), the field component of each Flex type,
// and ErrorMessages (the platform error code's message, `errors.codes.<code>`, and the fields' full
// messages). Every visible string is a translation: labels are human attribute names, the submit label
// is helpers.submit.*, the relation prompt helpers.select.prompt.
import { createContext, createElement as h, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createForm, fullMessage, submitLabel } from '../helpers/form.js';
import { humanAttributeName } from '../model.js';
import { api } from '../api.js';
import { recordLabel } from '../resource.js';
import { useI18n } from './i18n.js';
import { useSite } from './router.js';

const FormContext = createContext(null);

function useFormState(form) {
  return useSyncExternalStore(form.subscribe, form.getState, form.getState);
}

/** The form model and its state inside a FormWith. */
export function useForm() {
  const f = useContext(FormContext);
  if (!f) throw new Error('a field component renders inside <FormWith>');
  return f;
}

function Field({ name, children, input }) {
  const { form, state } = useForm();
  const i18n = useI18n();
  const errors = state.errors[name] ?? [];
  return h(
    'div',
    { className: errors.length ? 'field field_with_errors' : 'field' },
    h('label', { htmlFor: `${form.resource.entity}_${name}` }, humanAttributeName(form.resource, name, { i18n })),
    input,
    errors.length ? h('p', { className: 'field-error', role: 'alert' }, errors.join(', ')) : null,
    children,
  );
}

function inputProps(name, type) {
  const { form, state } = useForm();
  const field = form.fields.find((f) => f.name === name);
  if (!field) throw new Error(`resource "${form.resource.entity}" has no field "${name}"`);
  return {
    id: `${form.resource.entity}_${name}`,
    name,
    required: field.required,
    value: state.values[name],
    onChange: (e) => form.set(name, e.target.value),
    type,
    'aria-invalid': (state.errors[name] ?? []).length ? 'true' : undefined,
  };
}

const typed = (type, extra = {}) =>
  function TypedField({ name }) {
    return h(Field, { name, input: h('input', { ...inputProps(name, type), ...extra }) });
  };

export const TextField = typed('text');
export const IntegerField = typed('number', { step: 1 });
export const DecimalField = typed('text', { inputMode: 'decimal' });
export const DateField = typed('date');
export const DateTimeField = typed('datetime-local');
export const FileField = typed('text');

export function BooleanField({ name }) {
  const { form, state } = useForm();
  return h(Field, {
    name,
    input: h('input', {
      id: `${form.resource.entity}_${name}`,
      name,
      type: 'checkbox',
      checked: Boolean(state.values[name]),
      onChange: (e) => form.set(name, e.target.checked),
    }),
  });
}

export function JsonField({ name }) {
  return h(Field, { name, input: h('textarea', inputProps(name, undefined)) });
}

export const VectorField = JsonField;

/** A relation: a select over the target resource's records (their label field). */
export function RelationField({ name }) {
  const { form } = useForm();
  const i18n = useI18n();
  const { projection } = useSite();
  const field = form.fields.find((f) => f.name === name);
  const [options, setOptions] = useState([]);
  const prefix = field?.relation?.target_prefix;
  const target = field?.relation ? projection?.resources?.[field.relation.target] : undefined;
  useEffect(() => {
    if (!prefix) return;
    api('GET', `${prefix}?limit=200`).then((r) => setOptions(r?.records ?? []), () => setOptions([]));
  }, [prefix]);
  const props = inputProps(name, undefined);
  delete props.type;
  return h(Field, {
    name,
    input: h(
      'select',
      props,
      h('option', { value: '' }, i18n.t('helpers.select.prompt')),
      options.map((r) => h('option', { key: r.id, value: r.id }, target ? recordLabel(target, r) : r.id)),
    ),
  });
}

/** The field component of a Flex type. */
export function fieldFor(type) {
  return (
    {
      text: TextField, integer: IntegerField, decimal: DecimalField, boolean: BooleanField, date: DateField,
      datetime: DateTimeField, json: JsonField, vector: VectorField, relation: RelationField, file: FileField,
    }[type] ?? TextField
  );
}

/**
 * <FormWith resource={pet} record={record} onSubmit={(payload, form) => …} fields={{name: MyInput}}>
 * — without children it renders every field of the projection, then the submit button.
 */
export function FormWith({ resource, record, form: given, onSubmit, fields = {}, children, className = 'form' }) {
  const i18n = useI18n();
  const form = useMemo(() => given ?? createForm(resource, { record, i18n }), [given, resource, record, i18n]);
  const state = useFormState(form);
  const value = useMemo(() => ({ form, state }), [form, state]);
  function submit(event) {
    event.preventDefault();
    form.submit(onSubmit ?? (() => undefined));
  }
  const body =
    children ??
    h(
      'div',
      null,
      form.fields.map((f) => h(fields[f.name] ?? fieldFor(f.type), { key: f.name, name: f.name })),
      h('button', { type: 'submit', disabled: state.status === 'submitting' }, submitLabel(form.resource, form.id !== undefined, { i18n })),
    );
  return h(
    FormContext.Provider,
    { value },
    h('form', { className, onSubmit: submit, noValidate: true }, h(ErrorMessages, { error: state.base[0], resource: form.resource, errors: state.errors }), body),
  );
}

/**
 * <ErrorMessages error={apiError} /> — the platform code's message (`errors.codes.<code>`, spec S4 §
 * Locale files) and, with `resource` and `errors`, each field's full message.
 */
export function ErrorMessages({ error, resource, errors = {} }) {
  const i18n = useI18n();
  const fieldMessages = resource
    ? Object.entries(errors).flatMap(([field, list]) => list.map((m) => fullMessage(resource, field, m, { i18n })))
    : [];
  if (!error && fieldMessages.length === 0) return null;
  return h(
    'div',
    { className: 'error-messages', role: 'alert' },
    error ? h('p', null, i18n.t(`errors.codes.${error.code}`)) : null,
    fieldMessages.length ? h('ul', null, fieldMessages.map((m) => h('li', { key: m }, m))) : null,
  );
}
