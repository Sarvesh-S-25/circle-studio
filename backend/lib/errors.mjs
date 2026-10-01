// One error type for everything the API can refuse. The code decides the HTTP status.
const STATUS = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  busy: 409,
  too_large: 413,
  upstream: 502,
  not_ready: 503,
  internal: 500,
};

export class HttpError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.detail = detail;
  }
}

export const badRequest = (m, d) => new HttpError('bad_request', m, d);
export const forbidden = (m, d) => new HttpError('forbidden', m, d);
export const notFound = (m, d) => new HttpError('not_found', m, d);
export const conflict = (m, d) => new HttpError('conflict', m, d);
export const busy = (m, d) => new HttpError('busy', m, d);
export const tooLarge = (m, d) => new HttpError('too_large', m, d);
export const upstream = (m, d) => new HttpError('upstream', m, d);
export const notReady = (m, d) => new HttpError('not_ready', m, d);
