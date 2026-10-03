// The framework-neutral form model (FormHelper + ActiveModel::Validations + ActiveModel::Dirty): field
// state from the resource projection, client-side validation mirroring the Flex field policies (the
// server stays authoritative), dirty tracking, and the submit state. React binds it through
// useSyncExternalStore (`FormWith`).
//
// Validation messages resolve as ActiveModel::Error#generate_message does:
//   activemodel.errors.models.<entity>.attributes.<field>.<kind>, activemodel.errors.models.<entity>.<kind>,
//   activemodel.errors.messages.<kind>, errors.attributes.<field>.<kind>, errors.messages.<kind>
// and a full message is `errors.format` ("%{attribute} %{message}") over the human attribute name.
import { i18nFor } from '../i18n/current.js';
import { humanAttributeName, modelName } from '../model.js';

/** The value a form input shows for a stored value of a Flex type. */
export function toInput(type, value) {
  if (value === undefined || value === null) return type === 'boolean' ? false : '';
  switch (type) {
    case 'boolean':
      return Boolean(value);
    case 'datetime':
      return new Date(value).toISOString().slice(0, 16);
    case 'json':
    case 'vector':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/** The JSON value of a form input for a Flex type; undefined means "not set". Throws on a malformed json. */
export function toValue(type, raw) {
  if (type === 'boolean') return Boolean(raw);
  if (raw === '' || raw === undefined || raw === null) return undefined;
  switch (type) {
    case 'integer':
      return Number(raw);
    case 'datetime':
      return new Date(`${raw}Z`).toISOString(); // the input edits UTC
    case 'json':
    case 'vector':
      return JSON.parse(raw);
    default:
      return raw;
  }
}

/** The ActiveModel validation kind a raw input violates for its field, or null. */
export function validationKind(field, raw) {
  const empty = raw === '' || raw === undefined || raw === null || (field.type === 'boolean' ? false : false);
  if (empty) return field.required && field.type !== 'boolean' ? 'blank' : null;
  switch (field.type) {
    case 'integer':
      return /^-?\d+$/.test(String(raw).trim()) ? null : 'not_an_integer';
    case 'decimal':
      return /^-?\d+(\.\d+)?$/.test(String(raw).trim()) ? null : 'not_a_number';
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(String(raw)) ? null : 'invalid';
    case 'datetime':
      return Number.isFinite(Date.parse(`${raw}Z`)) ? null : 'invalid';
    case 'json':
    case 'vector':
      try {
        JSON.parse(raw);
        return null;
      } catch {
        return 'invalid';
      }
    default:
      return null;
  }
}

/** ActiveModel::Error#generate_message for (resource, field, kind). */
export function errorMessage(resource, field, kind, options = {}) {
  const i18n = i18nFor(options);
  if (!i18n) return kind;
  const e = resource.entity;
  const keys = [
    `activemodel.errors.models.${e}.attributes.${field}.${kind}`,
    `activemodel.errors.models.${e}.${kind}`,
    `activemodel.errors.messages.${kind}`,
    `errors.attributes.${field}.${kind}`,
    `errors.messages.${kind}`,
  ];
  const [first, ...rest] = keys;
  return i18n.t(first, {
    default: rest.map((key) => ({ key })),
    model: modelName(resource, { i18n }).human(),
    attribute: humanAttributeName(resource, field, { i18n }),
  });
}

/** ActiveModel::Errors#full_message. */
export function fullMessage(resource, field, message, options = {}) {
  const i18n = i18nFor(options);
  const attribute = humanAttributeName(resource, field, { i18n });
  if (!i18n) return `${attribute} ${message}`;
  return i18n.t('errors.format', { default: [{ key: 'activemodel.errors.format' }], attribute, message });
}

/**
 * createForm(resource, {record, i18n}) — the form model of one resource: a new record, or the edit of
 * `record` ({id, data}).
 */
export function createForm(resource, options = {}) {
  const i18n = () => i18nFor(options);
  const initial = Object.fromEntries(resource.fields.map((f) => [f.name, toInput(f.type, options.record?.data?.[f.name])]));
  let state = {
    values: { ...initial },
    initial: { ...initial },
    errors: {},
    base: [],
    status: 'idle',
    error: null,
    touched: {},
  };
  const listeners = new Set();
  const emit = () => listeners.forEach((l) => l());
  const setState = (patch) => {
    state = { ...state, ...patch };
    emit();
  };

  const model = {
    resource,
    id: options.record?.id,
    fields: resource.fields,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    set(name, value) {
      setState({ values: { ...state.values, [name]: value }, touched: { ...state.touched, [name]: true } });
    },
    /** Reload the edited record (and make its values the clean baseline). */
    load(record) {
      const values = Object.fromEntries(resource.fields.map((f) => [f.name, toInput(f.type, record?.data?.[f.name])]));
      model.id = record?.id;
      setState({ values, initial: { ...values }, errors: {}, base: [], touched: {} });
    },
    /** The fields whose value differs from the baseline (ActiveModel::Dirty#changed). */
    changed: () => resource.fields.map((f) => f.name).filter((n) => state.values[n] !== state.initial[n]),
    dirty: () => model.changed().length > 0,
    /** {field: [before, after]} (ActiveModel::Dirty#changes). */
    changes: () => Object.fromEntries(model.changed().map((n) => [n, [state.initial[n], state.values[n]]])),
    /** Validate every field; returns true when valid. */
    validate() {
      const errors = {};
      for (const f of resource.fields) {
        const kind = validationKind(f, state.values[f.name]);
        if (kind) errors[f.name] = [errorMessage(resource, f.name, kind, { i18n: i18n() })];
      }
      setState({ errors });
      return Object.keys(errors).length === 0;
    },
    /** The JSON body of the submit: set fields; on an update a cleared field is null. */
    payload() {
      const data = {};
      for (const f of resource.fields) {
        const v = toValue(f.type, state.values[f.name]);
        if (v !== undefined) data[f.name] = v;
        else if (model.id !== undefined) data[f.name] = null;
      }
      return data;
    },
    /** Map a platform error onto the form: base error, and per-field marks for flex.validation. */
    applyError(error) {
      const errors = {};
      const fields = error?.details?.fields;
      if (fields && typeof fields === 'object') {
        for (const name of Object.keys(fields)) {
          if (resource.fields.some((f) => f.name === name)) errors[name] = [errorMessage(resource, name, 'invalid', { i18n: i18n() })];
        }
      }
      setState({ errors, base: error ? [error] : [], status: 'failed', error });
    },
    /** Validate, then run `send(payload, form)`; the submit state follows the promise. */
    async submit(send) {
      if (!model.validate()) {
        setState({ status: 'failed', error: null });
        return undefined;
      }
      setState({ status: 'submitting', error: null, base: [] });
      try {
        const result = await send(model.payload(), model);
        setState({ status: 'succeeded', initial: { ...state.values } });
        return result;
      } catch (e) {
        model.applyError(e);
        return undefined;
      }
    },
  };
  return model;
}

/** Rails form_with's submit label: helpers.submit.create / update with %{model}. */
export function submitLabel(resource, persisted, options = {}) {
  const i18n = i18nFor(options);
  const model = modelName(resource, { i18n }).human();
  if (!i18n) return model;
  return i18n.t(persisted ? 'helpers.submit.update' : 'helpers.submit.create', { model });
}
