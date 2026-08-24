/**
 * The wire.
 *
 * One WebSocket carries every conversation a channel has: the collaborative
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

	export type Outgoing = Hello | Presence | Access | Channel | Deleted | Failure | Ping;

	/** A member, as everyone else sees them. */
	export type Member = {
		/** Verified GitHub login, used for attribution, avatar and cursor colour. */
		handle: string;
		/** Distinguishes two tabs belonging to the same handle. */
		client: string;
	};

	/** Sent once, immediately, to the socket that just joined. */
	export type Hello = KIND<"session:hello"> & {
		channelId: string;
		title: string;
		slug: string;
		updatedAt: string;
		you: Member;
		members: Member[];
		/** Effective repository capability for this connection. */
		canEdit: boolean;
		/** Repository mutation capability, independent of document archival. */
		canManage: boolean;
		archivedAt?: string;
		backgroundJobs: boolean;
		webResearch: boolean;
		chatReferences: boolean;
		chatSendAcks: boolean;
	};

	/** Durable channel metadata changed while this room was open. */
	export type Channel = KIND<"session:channel"> & {
		channelId: string;
		title: string;
		slug: string;
		updatedAt: string;
		canManage: boolean;
		archivedAt?: string;
	};

	/** Repository or document permission changed while the socket was open. */
	export type Access = KIND<"session:access"> & {
		canEdit: boolean;
		canManage: boolean;
	};

	/** The durable document was permanently deleted. This connection is terminal. */
	export type Deleted = KIND<"session:deleted"> & {
		channelId: string;
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

export type { Chat } from "./chat";
export type { Comment } from "./comment";
export type { Job } from "./job";
export type { Plan } from "./plan";
export type { Question } from "./question";
export type { Research } from "./research";

/** Everything a client may send. */
export type Incoming =
	| Session.Incoming
	| import("./chat").Chat.Incoming
	| import("./comment").Comment.Incoming
	| import("./job").Job.Incoming
	| import("./plan").Plan.Incoming
	| import("./question").Question.Incoming;

/** Everything a client may receive. */
export type Outgoing =
	| Session.Outgoing
	| import("./chat").Chat.Outgoing
	| import("./comment").Comment.Outgoing
	| import("./job").Job.Outgoing
	| import("./plan").Plan.Outgoing
	| import("./question").Question.Outgoing
	| import("./research").Research.Outgoing;
