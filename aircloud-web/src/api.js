// The same-origin API client over the platform error envelope
// {"error":{"code","message","correlation_id","details"}} — the seam #246's typed SDK replaces. Every
// call sends `Accept-Language: <current locale>` (spec S4 § Locale negotiation: the function runtime
// negotiates from it), and the release pin cookie rides with it (same origin).
import { currentI18n } from './i18n/current.js';

export class ApiError extends Error {
  constructor(status, code, message, details = {}, correlationId = '') {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? {};
    this.correlationId = correlationId ?? '';
  }
}

/**
 * api("GET", "/api/pets") — resolves to the parsed JSON body (null for 204); rejects with an ApiError
 * carrying the envelope's code, message, details and correlation id.
 * @param {{locale?: string, fetch?: typeof fetch, headers?: Record<string,string>}} [options]
 */
export async function api(method, path, body, options = {}) {
  const locale = options.locale ?? currentI18n()?.locale;
  const headers = { accept: 'application/json', ...(options.headers ?? {}) };
  if (locale) headers['accept-language'] = locale;
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await (options.fetch ?? fetch)(path, init);
  if (res.status === 204) return null;
  const text = await res.text();
  let value = null;
  if (text !== '') {
    try {
      value = JSON.parse(text);
    } catch {
      if (res.ok) throw new ApiError(res.status, 'invalid_response', 'the response is not JSON');
    }
  }
  if (!res.ok) {
    const err = (value && value.error) || {};
    throw new ApiError(res.status, err.code || `http_${res.status}`, err.message, err.details, err.correlation_id);
  }
  return value;
}
