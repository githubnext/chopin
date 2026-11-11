import type { ConversationPlan, Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * Chat drives the agent.
 *
 * Shared, like everything else in a room: one transcript, one turn at a time,
 * and anything said while a turn is running joins a queue rather than being
 * refused. The composer stays live even when the plan does not — a turn owns
 * the document, not Chat.
 */
export declare namespace Chat {
	export type Incoming =
		| Request<Send>
		| Request<Abort>
		| Request<Resume>
		| Request<PauseRun>
		| Request<ResumeRun>
		| Request<Unqueue>
		| Request<Delete>
		| Request<Retry>
		| Request<Wake>
		| Request<SetParticipation>
		| Request<SetModel>
		| Request<Typing>;

	export type Outgoing =
		| History
		| Message
		| Delta
		| Tool
		| State
		| Queue
		| Sent
		| Deleted
		| Retried
		| Woke
		| Removed
		| ParticipationState
		| ModelState
		| ModelUnreadable;

	/** Who said something. The agent is not a member, so it is named apart. */
	export type Author =
		| { kind: "member"; handle: string }
		| { kind: "agent" }
		| { kind: "system" };

	export type ToolStatus = "running" | "done" | "failed";

	/**
	 * A file or image sent with a message, as the server keeps it. `kind` is what its bytes are:
	 * `image` for a PNG, JPEG, WebP or GIF, `file` for text. `mimeType` is the type it is served
	 * as, never the one the sender claimed, and `size` is in bytes.
	 */
	export type Attachment = {
		id: string;
		name: string;
		kind: "image" | "file";
		mimeType: string;
		size: number;
	};

	export type ReferenceRequest =
		| { kind: "document"; channelId: string; start: number; end: number }
		| { kind: "research"; workspaceId: string; start: number; end: number }
		| CommandRequest
		| HeadingRequest
		| DecisionRequest
		| FileRequest;

	/**
	 * A mention of one of this document's own parts, by its identity and not its words: a heading
	 * by its `anchor` (its text as a lowercase slug, `-1`, `-2` after a repeat, in document order),
	 * a Decision by its id and a file of the document's repository by its path. The range holds
	 * the `@` token the person saw.
	 */
	export type HeadingRequest = { kind: "heading"; anchor: string; start: number; end: number };
	export type DecisionRequest = {
		kind: "decision";
		decisionId: string;
		start: number;
		end: number;
	};
	export type FileRequest = { kind: "file"; path: string; start: number; end: number };

	/**
	 * A command the composer's `/` list offered, run as the Planner's own: `commandKind` is the
	 * `kind` the Planner reported for it, so a name two kinds share is never run as the other. The
	 * server checks both against the commands the document's Planner reports now. The range holds
	 * its `/name` token, which opens the message.
	 */
	export type CommandRequest = {
		kind: "command";
		name: string;
		commandKind: string;
		start: number;
		end: number;
	};

	type ReferenceBase = {
		id: string;
		start: number;
		end: number;
		label: string;
		href: string;
		repositoryId: string;
		observedRevision: number;
	};

	export type DocumentReference = ReferenceBase & {
		kind: "document";
		channelId: string;
		observedSourceHash: string;
	};

	export type ResearchReference = ReferenceBase & {
		kind: "research";
		parentChannelId: string;
		workspaceId: string;
	};

	/**
	 * What a reference that names no other document carries: where its token sits and what it
	 * reads. It has no address, repository or revision of its own.
	 */
	type PointerBase = { id: string; start: number; end: number; label: string };

	/** A command, kept with the message that ran it; `label` is the `/name` token it opens with. */
	export type CommandReference = PointerBase & {
		kind: "command";
		name: string;
		commandKind: string;
	};

	/**
	 * A heading of this document, as it read when the message was sent: `label` is `@` and its
	 * text, `level` its depth (1 to 6) and `line` the line of the source it starts on. `anchor`
	 * identifies it, as `HeadingRequest` describes.
	 */
	export type HeadingReference = PointerBase & {
		kind: "heading";
		anchor: string;
		level: number;
		line: number;
	};

	/** A Decision of this document: `label` is `@` and its header, `decisionId` the record's id. */
	export type DecisionReference = PointerBase & { kind: "decision"; decisionId: string };

	/** A file of this document's repository, by its path from the root; `label` is `@` and the path. */
	export type FileReference = PointerBase & { kind: "file"; path: string };

	export type Reference =
		| DocumentReference
		| ResearchReference
		| CommandReference
		| HeadingReference
		| DecisionReference
		| FileReference;

	/** One tool call, as it appears beneath the message that made it. */
	export type Activity = {
		id: string;
		name: string;
		status: ToolStatus;
		/** Truncated and redacted; the arguments the model supplied, once its input finished. */
		args?: string;
		/**
		 * Truncated and redacted; partial output while running, final output once finished.
		 * With `error`, the failed tool's human-readable message.
		 */
		result?: string;
		/**
		 * Redacted; present, with status "failed", when the tool failed with a structured
		 * error. `code` is stable; `kind`, when present, is the name to show.
		 */
		error?: { code: string; kind?: string };
		/** Milliseconds since the epoch, set by the server when the tool's input began. */
		startedAt?: number;
		/** Present, with status "failed", when the Planner was refused permission to run the tool. */
		refused?: true;
		/** Milliseconds, once finished. */
		took?: number;
	};

	export type Entry = {
		id: string;
		author: Author;
		text: string;
		ts: number;
		/** A system notice about a decision card; text remains its fallback. */
		decision?:
			| {
				questionnaireId: string;
				kind: "prompt";
				generation: number;
				label?: string;
				/** Stable source identity for a refreshed advisory; absent on legacy prompts. */
				sourceMessageIds?: string[];
				suggestedOptionId?: string;
			}
			| {
				questionnaireId: string;
				kind: "scoped-choice";
				threadId: string;
				proposalId: string;
				cardId: string;
				optionId: string;
				label: string;
				scope: "spike";
				generation: number;
				triggerEventId: string;
				sources: ConversationPlan.SourceRef[];
			}
			| { questionnaireId: string; kind: "activity"; label?: string; generation?: never };
		/**
		 * A system notice that a comment was sent to the Planner; text remains its fallback.
		 *
		 * `excerpt` is a short cut of the marked passage, `note` the comment as sent, and
		 * `channelId` the child document holding the thread, absent when it is this one.
		 */
		comment?: { thread: string; excerpt: string; note: string; channelId?: string };
		/** True while the agent is still writing this one. */
		streaming?: boolean;
		tools?: Activity[];
		references?: Reference[];
		/**
		 * Images and files the sender sent with the message, in the order they were added. Everyone
		 * who can read the document reads them by `id` (see `attachmentPath`); a client that
		 * predates them ignores the field.
		 */
		attachments?: Attachment[];
		/** Present as `planner` on a member message sent to the Planner; the mention is stripped from `text`. */
		to?: "planner";
		/**
		 * How far a member message to the Planner has got: `sent` is saved on the server and not
		 * yet taken by the machine, `delivered` is taken by it, and `failed` can never be
		 * delivered as sent, for `deliveryFailure`. Absent on any other entry and on one saved
		 * before this existed, which reads as delivered.
		 */
		deliveryState?: DeliveryState;
		/** Why a `failed` message could not be delivered. */
		deliveryFailure?: DeliveryFailure;
		/**
		 * On a system notice that says a Planner turn ended without finishing its reply: why, so a
		 * client can offer the way back. Absent on any other entry and on one saved before this
		 * existed, which is only its `text`.
		 */
		turnFailure?: TurnFailure;
	};

	/**
	 * Why a Planner turn ended. `error` is the model's or harness's own failure, `detail` its words
	 * as reported; `refused` a tool the turn was not allowed to run, `tool` one it needed that is
	 * not offered, `timed-out` a turn that took too long, `unreachable` an agent that could not be
	 * reached, and `dropped` the machine's connection going while it replied (the connection's to
	 * tell, not a failure to retry). `request` is the member message that began the turn, and
	 * `focus` the child document that was open when it was sent, so a retry is the same turn.
	 */
	export type TurnFailure = {
		kind: "error" | "refused" | "tool" | "timed-out" | "unreachable" | "dropped";
		detail?: string;
		request?: string;
		focus?: string;
	};

	export type DeliveryState = "sent" | "delivered" | "failed";

	/**
	 * Why a message can never be delivered as it was sent: the machine was removed from the
	 * document, the sender can no longer write to it, or the document or the child it was sent
	 * from is gone.
	 */
	export type DeliveryFailure = "machine-removed" | "access-lost" | "document-unavailable";

	/** Transient Planner turn state. */
	export type Turn = {
		id: string;
		handle: string;
		started: number;
		/** Index of the first transcript entry after this turn began; transient like the turn. */
		entryOffset: number;
		/** Optional so earlier clients ignore it; milliseconds since the epoch, set by the server. */
		startedAt?: number;
		/** True after the Planner has sent non-empty prose. */
		responded: boolean;
	};

	/** One stage of a workflow run, in the order the run reached it. */
	export type RunStage = {
		id: string;
		name: string;
		/** IDs of parent stages in this report; absent in older or topology-free reports. */
		parentIds?: string[];
		/** A `ctx.tool` step rather than an agent stage. */
		kind?: "tool";
		status:
			| "pending"
			| "running"
			| "awaiting_input"
			| "paused"
			| "blocked"
			| "completed"
			| "failed"
			| "skipped"
			| "stopped";
		/** Seconds since the epoch. */
		started?: number;
		ended?: number;
	};

	/** An Atomic workflow run the Planner started and still carries after its turn. */
	export type Run = {
		id: string;
		name: string;
		status: "running" | "waiting" | "paused" | "finished" | "blocked" | "failed" | "stopped";
		/** Seconds since the epoch. */
		started: number;
		updated: number;
		ended?: number;
		/** The most recent stages, in the order the run reached them. */
		stages: RunStage[];
		/** Stages reached before the ones listed. */
		earlierStages?: number;
		/** Decisions questions the run is waiting on. */
		waiting: number;
		/**
		 * The Planner's connection dropped while this run was live: Chopin keeps the card as
		 * last reported, and the run goes on when the Planner reconnects. Absent otherwise.
		 */
		disconnected?: true;
	};

	export type Runs = Run[];

	/** Shared automatic participation; direct Planner messages still work while paused. */
	export type Participation = { enabled: boolean; paused: boolean };
	export type ParticipationState = KIND<"chat:participation"> & Participation;
	export type SetParticipation = KIND<"chat:participation"> & { paused: boolean };

	/**
	 * A model the document's agent can run, as its harness (or the client attached to the document)
	 * reports it. `id` is the exact string a turn names; `thinkingLevels` are the levels the model
	 * supports in the order to show them, absent or empty for a model with no reasoning control.
	 */
	export type ModelOption = {
		id: string;
		name: string;
		provider?: { id: string; name?: string };
		description?: string;
		thinkingLevels?: string[];
		/**
		 * What the model reads, as its client reported it: `image` where it reads images, `text`
		 * where it reads text. Absent when nothing was reported, which reads as text only: an
		 * image is sent to a model only when it says it reads them.
		 */
		inputTypes?: string[];
	};

	/** What a document's agent offers: absent entirely where its harness offers no choice. */
	export type ModelCatalog = {
		models: ModelOption[];
		/** The model, and thinking level, the agent uses until somebody chooses. */
		default?: { model: string; thinkingLevel?: string };
	};

	/**
	 * The model and thinking level somebody chose for the document's agent. A field left out means
	 * the agent's own default; an empty choice is the default of both.
	 */
	export type ModelChoice = { model?: string; thinkingLevel?: string };

	/**
	 * The document's model choice and what it can be chosen from, shared by everyone in the room:
	 * sent on join, to everyone when the choice or the catalog changes, and to the sender as the
	 * answer to `SetModel`. `catalog` is absent when nothing can be chosen, and the composer then
	 * offers no control. `choice` is the stored choice, which can name a model the catalog no longer
	 * offers, or one offered by no catalog at all (a client withdrew its models, an older one took
	 * its place); the agent then runs its default and says so in Chat, and the composer says so
	 * too. `choice` is left out, though one is stored, while what the harness offers is unknown (a
	 * remote Planner with no client attached, or one yet to report): it is neither gone nor honored.
	 * A turn that falls back for want of a catalog its client offered and never reported ends that
	 * for the client, and `choice` is then sent.
	 */
	export type ModelState = KIND<"chat:model"> & {
		catalog?: ModelCatalog;
		choice?: ModelChoice;
		/** The chosen model's catalog name, kept when the model is no longer offered. */
		modelName?: string;
		/**
		 * What `/` offers beyond Chopin's own commands: the commands the document's agent reports,
		 * in the order, spelling and with the duplicates it reported them. Absent where it
		 * reports none (an older client, or a harness with no commands), and the composer then
		 * offers only Chopin's own.
		 */
		commands?: CommandOption[];
	};

	/**
	 * One command the document's agent offers. `kind` says what it is, as the agent defines it:
	 * `skill`, `prompt` (a prompt template) and `workflow` are the ones Chopin knows. A command
	 * is run as `/name args`, except a workflow, which is asked for by name.
	 */
	export type CommandOption = { name: string; description?: string; kind: string };

	/**
	 * Sent to everyone in the room when a turn could not read the document's model choice, or the
	 * catalog to check it against, and so ran the agent's default (`unreadable: true`), and again
	 * when a later turn could read it (`false`). Only a change is sent; a person who joins while it
	 * holds is sent it after `History`, which ends what an earlier connection was told. The composer
	 * says so, in the words of `UNREADABLE_NOTICE`, until it ends.
	 */
	export type ModelUnreadable = KIND<"chat:model-unreadable"> & { unreadable: boolean };

	/**
	 * Choose the document's model and thinking level, from the next turn. Anyone who can write may.
	 * The server checks the choice against the catalog it reports now, and refuses one the catalog
	 * does not offer. Without a field the agent's own default applies.
	 */
	export type SetModel = KIND<"chat:model"> & ModelChoice;

	/** Ephemeral composer activity, with no draft content. */
	export type Typing = KIND<"chat:typing"> & { active: boolean };

	/** Everything said so far, sent on join. */
	export type History = KIND<"chat:history"> & {
		entries: Entry[];
		busy: boolean;
		turn?: Turn;
		runs?: Runs;
		queued: Waiting[];
		participation?: Participation;
	};

	/** A new entry, or a finished one replacing its streaming self. */
	export type Message = KIND<"chat:message"> & { entry: Entry };

	/** Text appended to an entry still being written. */
	export type Delta = KIND<"chat:delta"> & { id: string; text: string };

	/** A tool call starting, or finishing. */
	export type Tool = KIND<"chat:tool"> & { entry: string; activity: Activity };

	/** Whether a turn is running, and for whom, and any workflow runs outliving it. */
	export type State = KIND<"chat:state"> & {
		busy: boolean;
		turn?: Turn;
		runs?: Runs;
	};

	/** A message waiting for the current turn to end. */
	export type Waiting = {
		id: string;
		handle: string;
		text: string;
		references?: Reference[];
	};

	export type Queue = KIND<"chat:queue"> & { waiting: Waiting[] };
	export type Destination = "room" | "planner";

	/**
	 * Say something.
	 *
	 * Accepted whether or not a turn is running. If one is, this joins the
	 * queue and runs in order when the turn ends — nobody is made to wait in
	 * silence because somebody else prompted first.
	 */
	export type Send = KIND<"chat:send"> & {
		requestId: string;
		text: string;
		to: Destination;
		references?: ReferenceRequest[];
		/**
		 * The images and files to send with the message, by the `id` the upload returned (at most
		 * the server's per-message count). The server reads each from its own record, and refuses
		 * one that is not the sender's, not from this document, already sent with another
		 * message, or a kind the destination cannot take.
		 */
		attachments?: string[];
		/**
		 * The child document open beside this Chat, by channel id. Context for the
		 * Planner only: the server resolves it against this root's children and
		 * refuses one it cannot, and the Planner's child tools recheck it again.
		 */
		focus?: string;
	};

	/** The member message or queue entry is accepted by the server. */
	export type Sent = KIND<"chat:send"> & { id: string; queued: boolean };

	/**
	 * Stop the running turn and pause the Planner's workflow runs. Anyone may;
	 * the transcript records who did.
	 */
	export type Abort = KIND<"chat:abort">;

	/** Resume the workflow runs the Planner paused. Anyone may; the transcript records who did. */
	export type Resume = KIND<"chat:resume">;

	/** Pause one workflow run. Anyone may; the transcript records who did. */
	export type PauseRun = KIND<"chat:pause-run"> & { runId: string };

	/** Resume one paused workflow run. Anyone may; the transcript records who did. */
	export type ResumeRun = KIND<"chat:resume-run"> & { runId: string };

	/** Withdraw a queued message. Only its author may. */
	export type Unqueue = KIND<"chat:unqueue"> & { id: string };

	/**
	 * Delete a message the machine has not taken yet. Only its author may, and one that was
	 * taken, or is already gone, is refused. The message leaves the Chat for everyone and is never
	 * delivered.
	 */
	export type Delete = KIND<"chat:delete"> & { id: string };

	/** The message is deleted. */
	export type Deleted = KIND<"chat:delete"> & { id: string };

	/** A message was deleted before it was delivered; sent to everyone with the Chat open. */
	export type Removed = KIND<"chat:removed"> & { id: string };

	/**
	 * Send a `failed` message again, as it was. Only its author may. It is `sent` again, and
	 * waits and is delivered like any other.
	 */
	export type Retry = KIND<"chat:retry"> & { id: string };

	/** The message is waiting again. */
	export type Retried = KIND<"chat:retry"> & { id: string };

	/**
	 * Ask a machine to start the document's Planner now, as sending it a message does, without
	 * sending one. Authorized like `chat:send`: repository write access, and a document that is
	 * not archived or deleted. It changes nothing about a Planner that is attached, or whose
	 * connection dropped and whose work is kept for its return: the answer says so and the
	 * machine's own client is what resumes. It never replays a turn. It is the root document's;
	 * a child's Chat is its root's.
	 */
	export type Wake = KIND<"chat:wake">;

	/**
	 * `asked` is true when a machine that can run the Planner was asked to start it; its progress
	 * arrives as `session:planner`. When false, `why` says so: `attached` (nothing to start),
	 * `disconnected` (its machine's connection dropped; only that machine can resume it) or
	 * `held` (another account holds it) leave it as it is; `no-machine` means no machine that can
	 * run it is connected; `unavailable` means this server does not run Planners on machines.
	 */
	export type Woke = KIND<"chat:wake"> & {
		asked: boolean;
		why?: "attached" | "disconnected" | "held" | "no-machine" | "unavailable";
	};
}
