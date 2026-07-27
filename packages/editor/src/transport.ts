/**
 * The slice of the connection this package needs.
 *
 * Structural rather than imported so the editor stays free of any particular
 * socket implementation, and so a test can drive it with three functions.
 */

export type Unsubscribe = () => void;

export type Transport = {
	on<T>(kind: string, handler: (frame: T) => void): Unsubscribe;
	send(kind: string, payload?: Record<string, unknown>): void;
	ask<T>(kind: string, payload?: Record<string, unknown>): Promise<T>;
};

/** Mirrors the client's connection states, for read-only and status chrome. */
export type Connection = "connecting" | "connected" | "reconnecting" | "denied" | "closed";
