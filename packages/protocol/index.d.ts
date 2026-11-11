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
		| People
		| Access
		| Channel
		| Deleted
		| Planner
		| Restarting
		| Failure
		| Ping;

	/** The per-file, per-message count and per-message total caps, each a server setting. */
	export type AttachmentSettings = {
		maxBytes: number;
		maxCount: number;
		maxTotalBytes: number;
	};

	/** A member, as everyone else sees them. */
	export type Member = {
		/** Verified GitHub login, used for attribution, avatar and cursor colour. */
		handle: string;
		/** Distinguishes two tabs belonging to the same handle. */
		client: string;
		/** Roster profile when the connection claimed a demo actor; the handle is the roster ID. */
		actor?: { name: string; avatar: string };
		/**
		 * The profile picture GitHub's API returned for this login when they signed in, as the server
		 * stored it. Optional: absent for a demo actor and from a server that predates it, and a
		 * client then falls back to the picture at `github.com/<handle>.png`, which does not exist
		 * for every account (an Enterprise Managed User's `name_company`, for one).
		 */
		avatarUrl?: string;
	};

	/** A person a document names, with the picture GitHub gave their login. */
	export type Person = {
		/** The GitHub login, as written wherever the document names the person. */
		login: string;
		avatarUrl: string;
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
		/**
		 * The caps on what a message may carry, where this server takes images and files: absent
		 * from a server that does not, and the composer then offers none.
		 */
		attachments?: AttachmentSettings;
		/**
		 * Set where the deployment configured a transcription model for dictation, naming the
		 * provider it sends audio to. Absent by default: no audio is ever sent to the server.
		 */
		transcription?: { provider: string };
		/**
		 * The build of the client this server serves: the entry script its page names. A tab whose own
		 * build, sent as the socket's `build` query parameter, differs knows a newer server answered.
		 * Absent when the server serves no built client.
		 */
		build?: string;
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

	/**
	 * Who holds this document's remote Planner. `held` is a client that detached and
	 * keeps the document until `until` (ISO 8601) unless it reattaches. `disconnected`
	 * is a client whose connection dropped while it had workflow runs or open questions
	 * Chopin keeps for it: there is no deadline, and it resumes them when it reconnects
	 * (see docs/agent-connection.md). `starting` is a paired machine of `login`'s asked to start it, which has yet to
	 * attach; with `failure`, its backend has exited before attaching more than once in a
	 * row, and with `attempt`, its backend has exited before attaching at least once, so the launch
	 * in flight or next is that one. `attempt` is absent until one has, and never a guess. Only the
	 * GitHub login is named, never its machine or checkout.
	 */
	export type PlannerAttachment =
		| { state: "attached"; login: string }
		| { state: "held"; login: string; until: string }
		| { state: "disconnected"; login: string }
		| { state: "starting"; login: string; failure?: PlannerStartFailure; attempt?: number }
		| { state: "none" };

	/**
	 * Why a machine's Planner backend keeps failing to start, as its connector last said.
	 * `reason` is the last line the backend wrote to stderr that says why, else how it ended,
	 * with credentials masked and the home directory as `~`. `attempts` counts the launches
	 * in a row that exited before staying up and `at` is when the last one did (ISO 8601).
	 * The connector is retrying until the Planner attaches, which clears it.
	 */
	export type PlannerStartFailure = {
		attempts: number;
		reason: string;
		at: string;
	};

	/**
	 * Sent only under `HARNESS=remote`: once after `Hello`, then to the whole room
	 * whenever a client attaches, detaches or disconnects, its grace period ends, or its ownership
	 * is released by a sign-out, a Planner reset or the server closing its link, and
	 * whenever a machine is asked to start it or stops being asked.
	 * Other harnesses never send it.
	 */
	export type Planner = KIND<"session:planner"> & { planner: PlannerAttachment };

	/**
	 * The server is about to close this socket with 1012 because it is restarting, and a new process
	 * is expected to take over within `reconnectWithinMs`. Sent just before the close, so a client
	 * that sees the close as anything but 1012 still treats it as a restart. Older clients ignore it.
	 */
	export type Restarting = KIND<"session:restarting"> & { reconnectWithinMs: number };

	/** Broadcast whenever the membership of the room changes. */
	export type Presence = KIND<"session:presence"> & {
		members: Member[];
	};

	/**
	 * The profile pictures of people this document names who are not in the room, so that an
	 * author who has left is drawn as themselves: whoever spoke in Chat or in a comment thread,
	 * whoever settled or was asked about a decision, and whoever started a build. Sent to a
	 * socket before it is greeted with the document, and to the whole room when someone the room
	 * has not met is named by something said after, such as a coding agent's message posted
	 * through MCP. Present people carry theirs in `Member`. It goes only to sockets joined to the
	 * room, which are allowed to read it. Optional: an older client ignores the frame and guesses
	 * from each login.
	 */
	export type People = KIND<"session:people"> & { people: Person[] };

	/** A request could not be served. Carries the `rid` it answers. */
	export type Failure = KIND<"session:error"> & {
		message: string;
		/**
		 * Set for a refusal the client presents in full rather than as a generic
		 * failure. `planner-not-attached`: a Planner request under `HARNESS=remote`
		 * to a document no client is attached to; `message` says how to attach one.
		 * `planner-queue-full`: too many requests wait behind the Planner's running turn right now
		 * (never said of a machine that is away, which keeps every request). The request itself is
		 * fine and is sent again, with the same request id, once some have been answered.
		 * `temporarily-unavailable`: a refusal of a `chat:send` for a passing reason (storage busy,
		 * the room changing, too many sends being handled for a machine that is there, a lookup of a
		 * reference or of the open child that failed). The message is fine and is sent again, with
		 * the same request id, and is kept once and delivered once even if an earlier attempt was
		 * saved before its answer was lost. Any
		 * refusal of a send without a code or with `planner-not-attached` is final.
		 * `message-not-deletable`: the answer to a `chat:delete` that is final: the machine already
		 * took the message, or it is not the sender's. Any other refusal of a delete is for a passing
		 * reason, and the delete is asked again.
		 */
		code?:
			| "planner-not-attached"
			| "planner-queue-full"
			| "temporarily-unavailable"
			| "message-not-deletable";
	};

	/** Liveness, and the smallest thing that proves request correlation works. */
	export type Ping = KIND<"session:ping">;
}

/**
 * The Projects sidebar's own socket at `/ws/sidebar`, which carries unanswered
 * decision counts for every repository the sidebar shows whether or not a
 * document is open, and says when a repository's documents change. Admission authenticates the browser session only; each
 * repository is authorized when it is watched. Room sockets carry none of these
 * frames. Requests fail with `Session.Failure`, and `Session.Ping` works here too.
 */
export declare namespace Sidebar {
	export type Incoming = Request<Session.Ping> | Request<Watch> | Request<Unwatch>;

	export type Outgoing =
		| Decisions
		| Catalogue
		| Watched
		| Snapshot
		| Session.Restarting
		| Session.Failure
		| Session.Ping;

	/**
	 * A document in a watched repository joined, changed in or left its catalogue: someone
	 * created, renamed, archived, restored or deleted it. Sent to every socket watching the
	 * repository, the change's author's included. It names no title: read the repository's
	 * documents again, through the same access check as any read.
	 */
	export type Catalogue = KIND<"sidebar:catalogue"> & {
		repositoryId: string;
		channelId: string;
	};

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
	 * repository across several frames. Repeating a watched repository, even with no
	 * documents, also sends a fresh `Snapshot` ordered after every earlier frame, so
	 * a client can resynchronize a total it can no longer order. Send the full list
	 * after every connection.
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
export type { Experiment } from "./experiment";
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
	| import("./implementation").Implementation.Incoming
	| import("./job").Job.Incoming
	| import("./plan").Plan.Incoming
	| import("./question").Question.Incoming;

/** Everything a client may receive, on a room socket or the sidebar socket. */
export type Outgoing =
	| import("./experiment").Experiment.Changed
	| Session.Outgoing
	| Sidebar.Outgoing
	| import("./chat").Chat.Outgoing
	| import("./comment").Comment.Outgoing
	| import("./conversation-plan").ConversationPlan.Outgoing
	| import("./implementation").Implementation.Outgoing
	| import("./job").Job.Outgoing
	| import("./plan").Plan.Outgoing
	| import("./question").Question.Outgoing
	| import("./research").Research.Outgoing;
