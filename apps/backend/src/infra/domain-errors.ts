/** Base class for all domain errors. Carries an HTTP status code so the
 *  unified onError handler can map them without per-feature instanceof chains.
 *
 *  Feature errors extend the specific subclasses (NotFoundError, ValidationError,
 *  BusyError, ConflictError) rather than this base directly. */
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

/** Resource not found. Maps to HTTP 404. */
export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 404);
    this.name = "NotFoundError";
  }
}

/** Input validation failed. Maps to HTTP 422. */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 422);
    this.name = "ValidationError";
  }
}

/** Resource is busy (e.g. conversation has active run). Maps to HTTP 409. */
export class BusyError extends DomainError {
  constructor(resourceId: string) {
    super(`Resource busy: ${resourceId}`, 409);
    this.name = "BusyError";
  }
}

/** Conflict with current state (e.g. duplicate name). Maps to HTTP 409. */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409);
    this.name = "ConflictError";
  }
}
