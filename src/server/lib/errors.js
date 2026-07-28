/**
 * Fehlerklasse mit benutzerverständlicher Meldung (NFR2).
 * `code` ist maschinenlesbar, `message` wird 1:1 in der UI angezeigt.
 */
export class AppError extends Error {
  constructor(code, message, { status = 400, details = null, cause = null } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
    if (cause) this.cause = cause;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function isAppError(err) {
  return err instanceof AppError;
}
