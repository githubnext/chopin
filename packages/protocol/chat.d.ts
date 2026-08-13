import type { Frame, Request } from "./index";

type KIND<K extends string> = Frame & { kind: K };

/**
 * The conversation driving the agent.
 *
 * Shared, like everything else in a room: one transcript, one turn at a time,
 * and anything said while a turn is running joins a queue rather than being
 * refused. The composer stays live even when the plan does not — a turn owns
 * the document, not the conversation.
 */
export declare namespace Chat {
	export type Incoming =
		| Request<Send>
		| Request<Abort>
		| Request<Unqueue>;

	export type Outgoing = History | Message | Delta | Tool | State | Queue;

	/** Who said something. The agent is not a member, so it is named apart. */
	export type Author =
		| { kind: "member"; handle: string }
		| { kind: "agent" }
		| { kind: "system" };

	export type ToolStatus = "running" | "done" | "failed";

	/** One tool call, as it appears beneath the message that made it. */
	export type Activity = {
		id: string;
		name: string;
		status: ToolStatus;
		/** Rendered on demand; the arguments the model supplied. */
		args?: string;
		/** Present once finished. */
		result?: string;
		/** Milliseconds, once finished. */
		took?: number;
	};

	export type Entry = {
		id: string;
		author: Author;
		text: string;
		ts: number;
		/** True while the agent is still writing this one. */
		streaming?: boolean;
		tools?: Activity[];
	};

	/** Transient Planner turn state. */
	export type Turn = {
		id: string;
		handle: string;
		started: number;
		/** True after the Planner has sent non-empty prose. */
		responded: boolean;
	};

	/** Everything said so far, sent on join. */
	export type History = KIND<"chat:history"> & {
		entries: Entry[];
		busy: boolean;
		turn?: Turn;
		queued: Waiting[];
	};

	/** A new entry, or a finished one replacing its streaming self. */
	export type Message = KIND<"chat:message"> & { entry: Entry };

	/** Text appended to an entry still being written. */
	export type Delta = KIND<"chat:delta"> & { id: string; text: string };

	/** A tool call starting, or finishing. */
	export type Tool = KIND<"chat:tool"> & { entry: string; activity: Activity };

	/** Whether a turn is running, and for whom. */
	export type State = KIND<"chat:state"> & {
		busy: boolean;
		turn?: Turn;
	};

	/** A message waiting for the current turn to end. */
	export type Waiting = {
		id: string;
		handle: string;
		text: string;
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
	export type Send = KIND<"chat:send"> & { text: string; to: Destination };

	/** Stop the running turn. Anyone may; the transcript records who did. */
	export type Abort = KIND<"chat:abort">;

	/** Withdraw a queued message. Only its author may. */
	export type Unqueue = KIND<"chat:unqueue"> & { id: string };
}
