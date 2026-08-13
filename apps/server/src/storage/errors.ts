export type StorageFailure = "conflict" | "corrupt" | "missing" | "unavailable";

/** A provider-independent failure that domain services can handle deliberately. */
export class StorageError extends Error {
	readonly failure: StorageFailure;

	constructor(failure: StorageFailure, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StorageError";
		this.failure = failure;
	}
}

export function conflict(message: string): StorageError {
	return new StorageError("conflict", message);
}

export function corrupt(message: string, cause?: unknown): StorageError {
	return new StorageError("corrupt", message, { cause });
}

export function missing(message: string): StorageError {
	return new StorageError("missing", message);
}

export function unavailable(message: string, cause?: unknown): StorageError {
	return new StorageError("unavailable", message, { cause });
}
