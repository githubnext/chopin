/**
 * The wire.
 *
 * One WebSocket carries every live channel stream: the collaborative
 * document, its questionnaires, and Chat driving the agent. Frames are
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

	export type Outgoing =
		| Hello
		| Presence
		| Access
		| Channel
		| Deleted
		| Failure
		| Ping;

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
		descriptionRevision: number;
		description?: string;
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
		descriptionRevision: number;
		description?: string;
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

/**
 * The Projects sidebar's own socket at `/ws/sidebar`, which carries unanswered
 * decision counts for every repository the sidebar shows whether or not a
 * document is open. Admission authenticates the browser session only; each
 * repository is authorized when it is watched. Room sockets carry none of these
 * frames. Requests fail with `Session.Failure`, and `Session.Ping` works here too.
 */
export declare namespace Sidebar {
	export type Incoming = Request<Session.Ping> | Request<Watch> | Request<Unwatch>;

	export type Outgoing = Decisions | Watched | Snapshot | Session.Failure | Session.Ping;

	/**
	 * Unanswered decision counts read from authoritative question records after they
	 * were committed. Sent to every socket watching the repository whenever a commit
	 * changes a document's count, or a document leaves, rejoins, or is deleted from
	 * the active catalogue. Frames for one repository, including snapshots, are sent
	 * in the order their totals were read.
	 */
	export type Decisions = KIND<"sidebar:decisions"> & {
		channelId: string;
		repositoryId: string;
		/** Unanswered decisions in this document, the number its Decisions tab shows. */
		unanswered: number;
		/** Unanswered decisions across every document in the repository's active catalogue. */
		repositoryUnanswered: number;
		/** The channel storage revision `unanswered` was committed at, matching `Channel.revision`. */
		revision: number;
	};

	/** One repository the Projects sidebar shows, and loaded documents to reconcile there. */
	export type WatchedRepository = {
		/** GitHub node ID; authoritative, and must match what `owner/name` resolves to. */
		repositoryId: string;
		owner: string;
		name: string;
		/** Loaded documents whose counts the snapshot reconciles, at most 500. */
		channelIds: string[];
	};

	/**
	 * Watch decision counts for up to 50 repositories, each listed once. Watching is
	 * additive: a socket watches at most 200 repositories and refuses the excess.
	 * The server checks GitHub read access before subscribing a repository it is not
	 * already watching under the same name, and rechecks every watched repository
	 * periodically, dropping it when access is denied. Repeat a watched repository
	 * to reconcile documents loaded since; send more than 500 documents for one
	 * repository across several frames. Send the full list after every connection.
	 */
	export type Watch = KIND<"sidebar:watch"> & {
		repositories: WatchedRepository[];
	};

	/** Stop watching repositories the sidebar no longer shows, at most 200. Not answered. */
	export type Unwatch = KIND<"sidebar:unwatch"> & {
		repositoryIds: string[];
	};

	/**
	 * The reply to `Watch`. A `Snapshot` follows for each watched repository. Refused
	 * repositories are denied or over the limit; unavailable ones could not be checked
	 * because GitHub was temporarily unavailable and should be watched again later.
	 * A repository unwatched while it was being checked appears in no list.
	 */
	export type Watched = KIND<"sidebar:watched"> & {
		watched: string[];
		refused: string[];
		unavailable: string[];
	};

	/**
	 * Current counts for one watched repository, so a socket reconciles updates it
	 * missed while disconnected, before it subscribed, or before a document loaded.
	 */
	export type Snapshot = KIND<"sidebar:snapshot"> & {
		repositoryId: string;
		repositoryUnanswered: number;
		/** The requested documents that still belong to the repository. */
		documents: Array<{ channelId: string; unanswered: number; revision: number }>;
	};
}

export type { Chat } from "./chat";
export type { Comment } from "./comment";
export type { ConversationPlan } from "./conversation-plan";
export type { Job } from "./job";
export type { Plan } from "./plan";
export type { Question } from "./question";
export type { Research } from "./research";

/** Everything a client may send on a room socket; the sidebar socket accepts `Sidebar.Incoming`. */
export type Incoming =
	| Session.Incoming
	| import("./chat").Chat.Incoming
	| import("./comment").Comment.Incoming
	| import("./conversation-plan").ConversationPlan.Incoming
	| import("./job").Job.Incoming
	| import("./plan").Plan.Incoming
	| import("./question").Question.Incoming;

/** Everything a client may receive, on a room socket or the sidebar socket. */
export type Outgoing =
	| Session.Outgoing
	| Sidebar.Outgoing
	| import("./chat").Chat.Outgoing
	| import("./comment").Comment.Outgoing
	| import("./conversation-plan").ConversationPlan.Outgoing
	| import("./job").Job.Outgoing
	| import("./plan").Plan.Outgoing
	| import("./question").Question.Outgoing
	| import("./research").Research.Outgoing;
