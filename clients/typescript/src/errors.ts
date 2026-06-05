export interface SQLFSErrorOptions {
	code?: string;
	status?: number;
	details?: unknown;
}

export class SQLFSError extends Error {
	readonly code?: string;
	readonly status?: number;
	readonly details?: unknown;

	constructor(message: string, options: SQLFSErrorOptions = {}) {
		super(message);
		this.name = new.target.name;
		this.code = options.code;
		this.status = options.status;
		this.details = options.details;
	}
}

export class AuthError extends SQLFSError {}
export class NotFoundError extends SQLFSError {}
export class ConflictError extends SQLFSError {}
export class ValidationError extends SQLFSError {}
export class ServerError extends SQLFSError {}
export class TransportError extends SQLFSError {}

export class ExecTimeoutError extends SQLFSError {
	readonly durationMs?: number;

	constructor(message: string, options: SQLFSErrorOptions & { durationMs?: number } = {}) {
		super(message, options);
		this.durationMs = options.durationMs;
	}
}

export class RateLimitError extends SQLFSError {
	readonly retryAfter?: number;

	constructor(message: string, options: SQLFSErrorOptions & { retryAfter?: number } = {}) {
		super(message, options);
		this.retryAfter = options.retryAfter;
	}
}
