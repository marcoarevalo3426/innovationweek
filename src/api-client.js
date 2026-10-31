export const SERVICE_UNAVAILABLE_MESSAGE = 'The app service is unavailable. Please try again shortly.';

function unavailable(response, code, cause) {
  return Object.assign(new Error(SERVICE_UNAVAILABLE_MESSAGE, { cause }), {
    status: response?.status || 0,
    code,
  });
}

export async function parseApiResponse(response) {
  if (response.status === 204 && response.ok) return null;
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  // A static host, SPA fallback or proxy error can return an HTML page here.
  // Never parse/display that page as an API result or expose its raw contents.
  if (!/^application\/(?:[\w.-]+\+)?json$/.test(type)) {
    throw unavailable(response, 'API_NON_JSON_RESPONSE');
  }
  let data;
  try { data = await response.json(); }
  catch (cause) { throw unavailable(response, 'API_INVALID_JSON', cause); }
  if (!data || typeof data !== 'object') throw unavailable(response, 'API_INVALID_RESPONSE');
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : 'Something went wrong. Please try again.';
    throw Object.assign(new Error(message), { status: response.status, code: 'API_REQUEST_FAILED' });
  }
  return data;
}

export async function api(path, options = {}, fetchImpl = globalThis.fetch) {
  const multipart = options.body instanceof FormData;
  let response;
  try {
    response = await fetchImpl('/api' + path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        'X-Requested-With': 'InnovationWeek',
        ...(multipart ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
      body: multipart ? options.body : options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (cause) {
    if (cause.name === 'AbortError') throw cause;
    throw unavailable(null, 'API_NETWORK_ERROR', cause);
  }
  return parseApiResponse(response);
}
