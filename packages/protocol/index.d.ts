/**
 * The wire.
 *
 * One WebSocket carries every conversation a room has: the collaborative
 * document, its questionnaires, and the chat driving the agent. Frames are
 * JSON; binary payloads travel base64 because there is no second channel and
 * a text frame is legible in a network inspector.
 *
 * Types only. Nothing here has a runtime representation, so both the server
 * and the browser can depend on it without either pulling the other in.
 */

/** Every frame on the wire. */
export type Frame = {
	kind: string;
	/** Unix seconds, stamped by the sender. */
	ts: number;
	/**
	 * Correlates a reply with the request that asked for it.
	 *
	 * Present on every client request, and echoed on the single reply that
	 * answers it. Broadcasts carry no `rid` — nobody asked for them.
	 */
	rid?: string;
	/** Handle of the member a relayed frame originated from. */
	sender?: string;
};

type KIND<K extends string> = Frame & { kind: K };

/** A client frame, which must be correlatable. */
export type Request<T> = T & { rid: string };

/**
 * Connection lifecycle.
 *
 * Identity is asserted at the upgrade rather than in a frame: a socket belongs
 * to one member for its whole life, and re-asserting it per message would
 * invite frames that disagree with the connection that carried them.
 */
export declare namespace Session {
	export type Incoming = Request<Ping>;

	export type Outgoing = Hello | Presence | Failure | Ping;

	/** A member, as everyone else sees them. */
	export type Member = {
		/** Unverified GitHub handle, used for the avatar and cursor colour. */
		handle: string;
		/** Distinguishes two tabs belonging to the same handle. */
		client: string;
	};

	/** Sent once, immediately, to the socket that just joined. */
	export type Hello = KIND<"session:hello"> & {
		room: string;
		you: Member;
		members: Member[];
	};

	/** Broadcast whenever the membership of the room changes. */
	export type Presence = KIND<"session:presence"> & {
		members: Member[];
	};

	/** A request could not be served. Carries the `rid` it answers. */
	export type Failure = KIND<"session:error"> & {
		message: string;
	};

	/** Liveness, and the smallest thing that proves request correlation works. */
	export type Ping = KIND<"session:ping">;
}

/** Everything a client may send. */
export type Incoming = Session.Incoming;

/** Everything a client may receive. */
export type Outgoing = Session.Outgoing;
