/**
 * Base error class for openElinaro runtime errors.
 *
 * All domain-specific errors should extend this so callers can catch the
 * full family with a single `instanceof OpenElinaroError` check.
 */
export class OpenElinaroError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OpenElinaroError";
    this.code = code;
  }
}

/** Thrown when a requested entity cannot be found. */
export class NotFoundError extends OpenElinaroError {
  constructor(entity: string, id?: string, options?: ErrorOptions) {
    super("NOT_FOUND", id ? `${entity} not found: ${id}` : `${entity} not found`, options);
    this.name = "NotFoundError";
  }
}

/** Thrown when input fails validation. */
export class ValidationError extends OpenElinaroError {
  constructor(message: string, options?: ErrorOptions) {
    super("VALIDATION", message, options);
    this.name = "ValidationError";
  }
}

/** Thrown when a required configuration value is missing or invalid. */
export class ConfigurationError extends OpenElinaroError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIGURATION", message, options);
    this.name = "ConfigurationError";
  }
}

/** Thrown when an action is not permitted for the current profile/role. */
export class AuthorizationError extends OpenElinaroError {
  constructor(message: string, options?: ErrorOptions) {
    super("AUTHORIZATION", message, options);
    this.name = "AuthorizationError";
  }
}
