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
	/**
	 * Whether a request can be carried right now.
	 *
	 * A connection comes up on its own schedule, and whatever mounted against
	 * it does not. Asking rather than assuming is what stops a document being
	 * opened against a socket that has not finished its handshake — which
	 * fails once and, without this, forever.
	 *
	 * Optional so a test can still drive the transport with three functions.
	 * Absent means "assume it can", which is what a stub wants.
	 */
	readonly connected?: boolean;
};

/** Mirrors the client's connection states, for read-only and status chrome. */
export type Connection = "connecting" | "connected" | "reconnecting" | "denied" | "closed";
