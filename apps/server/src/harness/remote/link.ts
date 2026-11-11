/**
 * The server end of one agent connection: a client attached to a document whose
 * model runs Planner turns. Each Planner session Chopin opens becomes a
 * `start`, each turn a `turn`; the client streams parts back and calls
 * Chopin's host tools, which still run here against the room.
 */

import { HarnessCapabilityUnsupportedError } from "@ai-sdk/harness";
import {
	AGENT_FEATURES,
	AGENT_VERSION,
	encodeMessage,
	LINK_CLOSE,
	parseClientMessage,
	usableCatalog,
} from "@chopin/agent-link";

import type {
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
	HarnessV1ResumeSessionState,
	HarnessV1Session,
	HarnessV1StreamPart,
} from "@ai-sdk/harness";
import type {
	CapabilityCatalog,
	ClientMessage,
	ClientMessageOf,
	ProtocolErrorCode,
	RefusalCode,
	ServerMessage,
	ServerMessageOf,
	TurnAttachment,
} from "@chopin/agent-link";
import type { Chat as Wire } from "@chopin/protocol";
import type { JsonValue, PlannerHeldSession } from "../../storage/model";
import type { AskedInput, HumanInputStatus, InputMethod } from "../atomic/human-input";
import type { PlannerTurn } from "../turn-level";
import type { RemotePlanner } from "./registry";

const OPERATION_TIMEOUT_MS = 10_000;
const REVALIDATE_EVERY_MS = 5 * 60_000;
const MAX_OPEN_INPUTS = 16;
/** How many settled `input-request` ids a link remembers to refuse their reuse. */
const REMEMBERED_INPUTS = 1_024;
/** What an answer that keeps no session waiting calls once it is sent. */
const NO_DELIVERY = () => {};

function once(work: () => void): () => void {
	let done = false;
	return () => {
		if (done) return;
		done = true;
		work();
	};
}
/** How many controls whose wait ran out a link remembers, to hear their late answers. */
const MAX_LATE_CONTROLS = 64;
const LIVE_RUN = new Set(["running", "waiting", "paused"]);

export type LinkSocket = {
	send(text: string): void;
	close(code: number, reason: string): void;
};

export type AttachOutcome =
	| {
		ok: true;
		document: ServerMessageOf<"attached">["document"];
		/**
		 * Lets go of what attaching took, such as the document's Planner ownership. `suspended`
		 * says the link keeps its sessions for the account's next link to resume.
		 */
		detach?: (suspended?: boolean) => void;
		/** Takes the sessions an earlier link of this document's Planner kept, if any. */
		claim?: () => AgentLink | undefined;
		/** A suspended link has nothing left to keep: its ownership runs the ordinary grace period. */
		lapse?: () => void;
		/**
		 * Present when an earlier link of the same account still counts as attached: this link is
		 * attached only once its first message, a `resume` naming a session that earlier link
		 * holds, shows that its client is returning to it and its connection is gone.
		 */
		takeover?: (names: ClientMessageOf<"resume">["sessions"] | undefined) => Promise<AttachOutcome>;
	}
	| { ok: false; code: RefusalCode; message: string };

export type LinkOptions = {
	/** Resolves the document the client asked for and takes its Planner, or refuses. */
	attach(message: ClientMessageOf<"attach">): Promise<AttachOutcome>;
	/** Rechecks the caller's access; false closes the link. */
	revalidate?(): Promise<boolean>;
	/** Records the attached link and returns how to forget it. */
	register?(channelId: string, link: AgentLink): () => void;
	timeoutMs?: number;
	/** How often an attached link's access is rechecked while it stays open. */
	revalidateEveryMs?: number;
	/** The features `attached` names; absent when the client asked for none. */
	features?: string[];
	/** The client reported what it offers, which may be nothing now; read it from `catalog`. */
	catalogChanged?(): void;
};

const REFUSAL_CLOSE: Record<RefusalCode, number> = {
	"unsupported-version": LINK_CLOSE.unsupportedVersion,
	"repository-forbidden": LINK_CLOSE.forbidden,
	"access-revoked": LINK_CLOSE.forbidden,
	"document-unavailable": LINK_CLOSE.unavailable,
	"document-archived": LINK_CLOSE.unavailable,
	"planner-attached": LINK_CLOSE.attached,
	"sign-in-required": LINK_CLOSE.unauthorized,
	unavailable: LINK_CLOSE.failed,
};

export class ToolBoundaryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolBoundaryError";
	}
}

function unsupported(capability: string): HarnessCapabilityUnsupportedError {
	return new HarnessCapabilityUnsupportedError({
		harnessId: "remote",
		message: `The remote Planner does not support ${capability}.`,
	});
}

/** The client did not answer in time, which does not say whether it heard. */
class Unanswered extends Error {}

function within<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Unanswered(message)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * What a turn's prompt comes to for an attached client. With `attachments` its images and text
 * files go in the turn's own field, as bytes; without it a client is sent what it has always been
 * sent, the prompt as text: each text file written into it under its name, and an image, which the
 * client cannot be given, said in words so the model can tell the person it could not see it.
 */
export function promptParts(
	prompt: HarnessV1PromptTurnOptions["prompt"],
	takesAttachments: boolean,
): { prompt: string; attachments: TurnAttachment[] } {
	if (typeof prompt === "string") return { prompt, attachments: [] };
	if (typeof prompt.content === "string") return { prompt: prompt.content, attachments: [] };
	let texts: string[] = [];
	let attachments: TurnAttachment[] = [];
	for (let part of prompt.content) {
		if (part.type === "text") {
			texts.push(part.text);
			continue;
		}
		let image = part.type === "image";
		let data = part.type === "image" ? part.image : part.type === "file" ? part.data : undefined;
		if (!(data instanceof Uint8Array)) throw unsupported(`${part.type} prompt parts`);
		let name = part.type === "file"
			? part.filename ?? "file"
			: String((part.providerOptions?.chopin as { name?: unknown } | undefined)?.name ?? "image");
		if (takesAttachments) {
			attachments.push({
				id: crypto.randomUUID(),
				name,
				kind: image ? "image" : "file",
				mediaType: part.mediaType ?? "application/octet-stream",
				size: data.byteLength,
				data: Buffer.from(data).toString("base64"),
			});
		} else if (image) {
			texts.push(
				`(An image, ${name}, was sent with this message, but this client can't be given images.)`,
			);
		} else {
			texts.push(`<file name=${JSON.stringify(name)}>\n${new TextDecoder().decode(data)}\n</file>`);
		}
	}
	return { prompt: texts.join("\n\n"), attachments };
}

function hostError(message: string): { error: string } {
	return { error: message };
}

type LinkPart = ClientMessageOf<"part">["part"];
type LinkUsage = Extract<LinkPart, { type: "finish-step" }>["usage"];

function finishReason(reason: Extract<LinkPart, { type: "finish-step" }>["finishReason"]) {
	return { unified: reason.unified, raw: reason.raw };
}

function usage(value: LinkUsage) {
	let { inputTokens, outputTokens } = value;
	return {
		inputTokens: {
			total: inputTokens.total,
			noCache: inputTokens.noCache,
			cacheRead: inputTokens.cacheRead,
			cacheWrite: inputTokens.cacheWrite,
		},
		outputTokens: {
			total: outputTokens.total,
			text: outputTokens.text,
			reasoning: outputTokens.reasoning,
		},
	};
}

type Port = {
	send(message: ServerMessage): boolean;
	control(
		session: string,
		action: "stop" | "resume",
		runId?: string,
		sent?: (request: string) => void,
	): Promise<void>;
	forget(session: string): void;
	/** Whether the client's work in `session` goes on past a restart: it is kept, not destroyed. */
	kept(session: string): boolean;
	/** Throws, closing the link, when the caller can no longer read the document. */
	revalidate(): Promise<void>;
	timeoutMs: number;
	/** The features the client asked for that this server supports; absent when it asked for none. */
	features?: readonly string[];
};

type Turn = {
	id: string;
	emit: (part: HarnessV1StreamPart) => void;
	hostNames: Set<string>;
	own: Set<string>;
	ownCalls: Set<string>;
	/** Every host call id the turn has used, refused ones too, so none runs twice. */
	hostIds: Set<string>;
	hostCalls: Map<string, string>;
	stopped: boolean;
	ended: boolean;
	settle: PromiseWithResolvers<void>;
	/** Aborted when the turn ends, so the server's host tools still running for it stop too. */
	hostTools?: AbortController;
	grace?: ReturnType<typeof setTimeout>;
	listeners: (() => void)[];
};

type TurnMessage = ClientMessageOf<"tools" | "part" | "host-tool-call" | "turn-end">;

/** The client answered a Stop or Resume with a refusal: it heard the request, so nothing is owed. */
class ControlRefused extends Error {}

/**
 * A Stop sent to the client and not yet answered, naming its run (none: every run). `origin` is
 * the Stop of every run this one stands for after a Resume of another run undid part of it.
 */
type OwedStop = {
	run: string | undefined;
	held?: true;
	origin?: OwedStop;
	/** The control request that carries it, so a late answer finds it. */
	request?: string;
};

/** An answer the client has not acknowledged, and the claim that keeps its session until it has. */
type Owed = {
	result: ServerMessageOf<"input-result">;
	session: string;
	delivered: () => void;
	/** Runs once if the answer is dropped without its client ever being given it. */
	unsent?: () => void;
};

/** A request waiting on the document's members, and the decisions it asked once they exist. */
type OpenInput = {
	session: string;
	controller: AbortController;
	method: InputMethod;
	decisions: string[];
	/** Kept across a restart: its decisions are asked again once the document's room is open. */
	restored?: true;
	/** The host this was last asked again through; a result of an earlier one is not sent. */
	joined?: RejoinHost;
};

/**
 * What a rebuilt link needs from the document's room, once it is open, to wait again for the
 * answers to the questions its client left open.
 */
export type RejoinHost = {
	/** Waits for the decisions a request asked, and returns what its client is to be given. */
	join(
		asked: AskedInput,
		signal: AbortSignal,
	): Promise<{ status: HumanInputStatus; value: unknown }>;
	/**
	 * Decisions answered whose answer its client can never be given: it did not come back for
	 * it. They are handed to the Planner as a turn, as a decision nobody waits on is.
	 */
	unsent(decisions: string[]): void;
};

/** One Planner session whose turns run in the attached client. */
class RemoteSession {
	readonly id: string;
	readonly planner: RemotePlanner;
	#port: Port;
	#started = Promise.withResolvers<void>();
	/** Whether the client has acknowledged `start`: only a started session can be resumed. */
	#acknowledged = false;
	#current: Turn | undefined;
	#closed = false;
	#roots = new Map<string, string>();
	/** Every reported stage of each run, by id, in the order first reported. */
	#stages = new Map<string, Map<string, Wire.RunStage>>();
	/**
	 * Stops asked for while the link was down, each naming its run (none: every run), for the
	 * client to hear first when it resumes. A Stop is never lost to a network failure.
	 */
	#held: Array<{ run: string | undefined }> = [];
	/**
	 * Stops sent to the client that it has not answered. The client may never have heard one, or
	 * have applied it and lost only its answer, so a link that drops before the answer still owes
	 * the client the Stop: `suspend` moves these to `#held`. A Stop that went unanswered for as
	 * long as the server waits stays here too, for a link that is only noticed to be dead later.
	 */
	#unanswered = new Set<OwedStop>();
	/** The Stops sent and not yet answered, by control request, for an answer that comes late. */
	#requests = new Map<string, OwedStop>();

	constructor(id: string, planner: RemotePlanner, port: Port) {
		this.id = id;
		this.planner = planner;
		this.#port = port;
		void this.#started.promise.catch(() => {});
	}

	/** Whether a turn is under way: the Planner is replying. */
	get replying(): boolean {
		return this.#current !== undefined;
	}

	async start(): Promise<HarnessV1Session> {
		let mode = this.planner.isolated ? "isolated" as const : "planner" as const;
		if (!this.#port.send({ type: "start", session: this.id, mode })) {
			throw new Error("The agent connection is closed.");
		}
		await within(
			this.#started.promise,
			this.#port.timeoutMs,
			"The machine did not start the session.",
		);
		this.planner.control = (action, runId) => this.#command(action, runId);
		this.planner.rootOf = runId => this.#roots.get(runId) ?? runId;
		return this.#session();
	}

	acknowledge(message: ClientMessageOf<"started" | "start-failed">): void {
		if (message.type === "started") {
			this.#acknowledged = true;
			this.#started.resolve();
		} else {this.#started.reject(
				new Error(`The machine refused the session: ${message.message}`),
			);}
	}

	/** The root run a workflow question belongs to, so a paused root holds its answers. */
	rememberRoot(runId: string, rootRunId: string): void {
		this.#roots.set(runId, rootRunId);
	}

	/**
	 * Takes a report: a full card's stages replace the run's, a delta card's are added by id to
	 * them. A full card with no stages for a run that has some keeps them, as a client that
	 * reattaches may report an ended run without its stages. The Planner always sees every stage
	 * of each run.
	 */
	reportRuns(message: Pick<ClientMessageOf<"runs">, "active" | "paused" | "cards">): void {
		if (this.#closed || this.planner.isolated) return;
		let previous = new Map(this.planner.runs?.cards.map(card => [card.id, card]));
		let cards = message.cards.map((card): Wire.Run => {
			if (!("stagesDelta" in card)) {
				let kept = this.#stages.get(card.id);
				if (!card.stages.length && kept?.size) {
					let { earlierStages: _, ...fields } = card;
					let earlierStages = previous.get(card.id)?.earlierStages;
					return {
						...fields,
						stages: [...kept.values()],
						...(earlierStages ? { earlierStages } : {}),
					};
				}
				this.#stages.set(card.id, new Map(card.stages.map(stage => [stage.id, stage])));
				return card;
			}
			let { stagesDelta: _, stages: delta, ...fields } = card;
			let stages = this.#stages.get(card.id) ?? new Map<string, Wire.RunStage>();
			this.#stages.set(card.id, stages);
			for (let stage of delta) stages.set(stage.id, stage);
			let earlierStages = previous.get(card.id)?.earlierStages;
			return {
				...fields,
				stages: [...stages.values()],
				...(earlierStages ? { earlierStages } : {}),
			};
		});
		let reported = new Set(cards.map(card => card.id));
		for (let id of this.#stages.keys()) if (!reported.has(id)) this.#stages.delete(id);
		this.planner.runs = { active: message.active, paused: message.paused, cards };
		this.planner.onRuns?.(this.planner.runs);
		for (let wake of this.planner.waiters ?? []) wake();
	}

	/** Whether the session has a live or paused run: work the client carries on while unseen. */
	get working(): boolean {
		let runs = this.planner.runs;
		return !this.#closed && !!runs && (runs.active.length > 0 || runs.paused.length > 0);
	}

	/** Whether the client could take the session back: it started, and is not an isolated job. */
	get resumable(): boolean {
		return this.#acknowledged && !this.#closed && !this.planner.isolated;
	}

	/**
	 * The link dropped unexpectedly and the session waits for its client to come back. The turn
	 * under way fails, as it always did, and its host tools stop; the session, its reported runs
	 * and its open questions are left exactly as they were. A Stop cannot reach the client now,
	 * so it is held for the client to hear first when it resumes: one pressed from now on, and
	 * one already sent whose answer never came.
	 */
	suspend(): void {
		// A server going down is not the client dropping: nothing is announced as disconnected.
		if (!this.planner.stopping) {
			this.planner.suspended = true;
			this.planner.keptStop = this.#unanswered.size > 0;
			this.planner.linkChanged?.();
		}
		let turn = this.#current;
		if (turn) {
			this.#finish(
				turn,
				turn.stopped ? undefined : new Error("The machine disconnected during the turn."),
			);
		}
		for (let owed of this.#unanswered) {
			owed.held = true;
			if (owed.origin) owed.origin.held = true;
			this.#hold("stop", owed.run);
		}
		this.#unanswered.clear();
		this.#requests.clear();
	}

	/**
	 * Stops or resumes the client's runs, as Chat's Stop and a run's pause and Resume do. Resolves
	 * `held` instead of an answer for a Stop the link's drop kept for the client's return, and
	 * `unconfirmed` for one the client did not answer in time, which stays owed: the caller must
	 * not report either as done. A Resume cannot be promised, so it is refused while the link is
	 * down and rejects when unanswered.
	 */
	async #command(
		action: "stop" | "resume",
		run: string | undefined,
	): Promise<void | "held" | "unconfirmed"> {
		if (this.planner.suspended) {
			this.#hold(action, run);
			return "held";
		}
		let owed: OwedStop | undefined = action === "stop" ? { run } : undefined;
		if (owed) this.#unanswered.add(owed);
		try {
			await this.#port.control(this.id, action, run, request => {
				if (!owed) return;
				owed.request = request;
				this.#requests.set(request, owed);
			});
		} catch (error) {
			if (owed?.held) return "held";
			// A refusal is an answer. Silence is not, and keeps the Stop owed.
			if (owed && error instanceof ControlRefused) this.#answered(owed);
			if (owed && error instanceof Unanswered) return "unconfirmed";
			throw error;
		}
		if (owed) this.#answered(owed);
		if (action === "resume") this.#undoStops(run);
	}

	/** The client answered a Stop, in time or late: it, and the Stops split from it, are not owed. */
	#answered(owed: OwedStop): void {
		this.#unanswered.delete(owed);
		if (owed.request) this.#requests.delete(owed.request);
		for (let other of this.#unanswered) if (other.origin === owed) this.#unanswered.delete(other);
	}

	/** An answer to a Stop arrived after the wait for it ended. */
	answeredLate(request: string): void {
		let owed = this.#requests.get(request);
		if (owed) this.#answered(owed);
	}

	/**
	 * A Resume the client answered came after a Stop it never answered, so that Stop is undone for
	 * the runs the Resume covers, and stands for the rest: sending it again must not pause a run a
	 * person resumed, and dropping it must not lose its pause of another. A Stop of every run is
	 * kept as a Stop of each run the client reports except the one resumed.
	 */
	#undoStops(resumed: string | undefined): void {
		for (let owed of this.#unanswered) {
			if (resumed !== undefined && owed.run !== undefined && owed.run !== resumed) continue;
			this.#unanswered.delete(owed);
			if (resumed === undefined || owed.run !== undefined) continue;
			for (let card of this.planner.runs?.cards ?? []) {
				if (card.id === resumed || !LIVE_RUN.has(card.status)) continue;
				this.#unanswered.add({ run: card.id, origin: owed.origin ?? owed });
			}
		}
	}

	/** Keeps a Stop for the client's return; a Resume cannot be promised, so it is refused. */
	#hold(action: "stop" | "resume", run: string | undefined): void {
		if (action !== "stop") {
			throw new Error("The machine is disconnected, so its runs cannot be resumed yet.");
		}
		// Stopping every run covers each one, and a run already named is not named twice.
		if (this.#held.some(held => held.run === undefined || held.run === run)) return;
		if (run === undefined) this.#held = [];
		this.#held.push({ run });
	}

	/** The server is going down: nothing is reported about this session from here on. */
	shutdown(): void {
		this.planner.stopping = true;
	}

	/** The client is back on another link, which carries the session from here on. */
	rebind(port: Port): void {
		this.#port = port;
		this.planner.suspended = false;
		this.planner.keptStop = false;
		this.planner.linkChanged?.();
	}

	/**
	 * A session a process that has since restarted kept for its client: the client started it, and
	 * its link is down. The Stops it was owed are held for its return.
	 */
	restore(stops: JsonValue[]): void {
		this.#acknowledged = true;
		this.planner.suspended = true;
		for (let stop of stops) {
			let run = (stop as { run?: string | null } | null)?.run;
			this.#hold("stop", typeof run === "string" ? run : undefined);
		}
	}

	/** The Stops the client has yet to hear, held or sent and unanswered, for a hold to keep. */
	heldStops(): JsonValue[] {
		let stops: Array<{ run: string | undefined }> = [];
		let add = (run: string | undefined) => {
			if (stops.some(held => held.run === undefined || held.run === run)) return;
			if (run === undefined) stops = [];
			stops.push({ run });
		};
		for (let { run } of this.#held) add(run);
		for (let { run } of this.#unanswered) add(run);
		return stops.map(({ run }) => ({ run: run ?? null }));
	}

	/** Gives the client each Stop held while its link was down, once. */
	deliverHeldStops(): void {
		for (let { run } of this.#held.splice(0)) {
			// A link that drops again before the client answers keeps the Stop for the next one.
			this.#command("stop", run).catch(error => {
				if (!this.#closed && !this.planner.suspended) {
					console.error("[agent] a held Stop failed:", error);
				}
			});
		}
	}

	/** The link is gone for good: nothing more will arrive for this session. */
	linkClosed(): void {
		this.planner.suspended = false;
		this.#started.reject(new Error("The agent connection closed."));
		let reported = this.planner.runs;
		// A server going down stopped nothing: its cards are left as they were reported.
		if (reported && !this.planner.stopping) {
			this.reportRuns({
				active: [],
				paused: [],
				cards: reported.cards.map(card =>
					LIVE_RUN.has(card.status) ? { ...card, status: "stopped" as const } : card
				),
			});
		}
		let turn = this.#current;
		if (turn) {
			this.#finish(
				turn,
				turn.stopped ? undefined : new Error("The machine disconnected during the turn."),
			);
		}
		this.#closed = true;
		this.planner.control = undefined;
	}

	receive(message: TurnMessage): void {
		let turn = this.#current;
		if (!turn || turn.id !== message.turn || turn.ended) {
			if (message.type === "host-tool-call") {
				this.#port.send({
					type: "host-tool-result",
					session: this.id,
					turn: message.turn,
					toolCallId: message.toolCallId,
					output: hostError("The turn has ended."),
					isError: true,
				});
			}
			return;
		}
		if (message.type === "turn-end") {
			let failure = message.status === "finished" || turn.stopped
				? undefined
				: new Error(
					message.message
						?? (message.status === "aborted"
							? "The machine stopped the turn."
							: "The machine's turn failed."),
				);
			return this.#finish(turn, failure);
		}
		if (turn.stopped) {
			if (message.type === "host-tool-call") this.#refuseHostCall(turn, message, "aborted");
			return;
		}
		if (message.type === "tools") return this.#offer(turn, message.names);
		if (message.type === "host-tool-call") return this.#hostCall(turn, message);
		this.#part(turn, message.part);
	}

	#offer(turn: Turn, names: string[]): void {
		if (this.planner.isolated && names.length) {
			return this.#fail(
				turn,
				new ToolBoundaryError(`An isolated Planner turn cannot offer ${names.join(", ")}.`),
			);
		}
		let clash = names.filter(name => turn.hostNames.has(name));
		if (clash.length) {
			return this.#fail(
				turn,
				new ToolBoundaryError(`The machine redefined Chopin's ${clash.join(", ")}.`),
			);
		}
		turn.own = new Set(names);
		this.planner.activeTools = [...turn.hostNames, ...names];
	}

	#hostCall(turn: Turn, message: ClientMessageOf<"host-tool-call">): void {
		if (turn.hostIds.has(message.toolCallId) || turn.ownCalls.has(message.toolCallId)) {
			return this.#repeated(turn, message.toolCallId);
		}
		turn.hostIds.add(message.toolCallId);
		if (!turn.hostNames.has(message.toolName)) {
			return this.#refuseHostCall(turn, message, "unavailable");
		}
		turn.hostCalls.set(message.toolCallId, message.toolName);
		turn.emit({
			type: "tool-call",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			input: message.input,
		});
	}

	#refuseHostCall(
		turn: Turn,
		message: ClientMessageOf<"host-tool-call">,
		reason: "aborted" | "unavailable",
	): void {
		this.#port.send({
			type: "host-tool-result",
			session: this.id,
			turn: turn.id,
			toolCallId: message.toolCallId,
			output: hostError(
				reason === "aborted"
					? "The turn was aborted."
					: `${message.toolName} is not available in this turn.`,
			),
			isError: true,
		});
	}

	#repeated(turn: Turn, toolCallId: string): void {
		this.#fail(turn, new Error(`Tool call ${toolCallId} was repeated.`));
	}

	#part(turn: Turn, part: LinkPart): void {
		let boundary = (name: string) =>
			this.#fail(turn, new ToolBoundaryError(`Chopin's tool boundary failure: ${name}`));
		switch (part.type) {
			case "tool-input-start":
				if (turn.hostNames.has(part.toolName)) {
					let { providerExecuted: _executed, dynamic: _dynamic, ...host } = part;
					return turn.emit(host);
				}
				if (!turn.own.has(part.toolName)) return boundary(part.toolName);
				return turn.emit({ ...part, providerExecuted: true, dynamic: true });
			case "tool-call":
				if (!turn.own.has(part.toolName)) return boundary(part.toolName);
				if (turn.hostIds.has(part.toolCallId) || turn.ownCalls.has(part.toolCallId)) {
					return this.#repeated(turn, part.toolCallId);
				}
				turn.ownCalls.add(part.toolCallId);
				return turn.emit({ ...part, dynamic: true });
			case "tool-result": {
				if (!turn.ownCalls.has(part.toolCallId)) return boundary(part.toolName);
				let result = (part.result ?? null) as NonNullable<unknown>;
				this.planner.toolReport?.(
					part.toolCallId,
					result,
					part.preliminary ? "running" : part.isError ? "failed" : "done",
				);
				return turn.emit({ ...part, result, dynamic: true });
			}
			case "error":
				return turn.emit({ type: "error", error: new Error(part.error) });
			case "finish-step":
				return turn.emit({
					type: "finish-step",
					finishReason: finishReason(part.finishReason),
					usage: usage(part.usage),
				});
			case "finish":
				return turn.emit({
					type: "finish",
					finishReason: finishReason(part.finishReason),
					totalUsage: usage(part.totalUsage),
				});
			default:
				return turn.emit(part);
		}
	}

	#stop(turn: Turn): void {
		if (turn.stopped || turn.ended) return;
		turn.stopped = true;
		this.#port.send({ type: "abort", session: this.id, turn: turn.id });
		turn.grace = setTimeout(() => this.#finish(turn), this.#port.timeoutMs);
	}

	#fail(turn: Turn, error: Error): void {
		if (!turn.stopped) {
			turn.stopped = true;
			this.#port.send({ type: "abort", session: this.id, turn: turn.id });
		}
		this.#finish(turn, error);
	}

	#finish(turn: Turn, error?: Error): void {
		if (turn.ended) return;
		turn.ended = true;
		clearTimeout(turn.grace);
		for (let release of turn.listeners.splice(0)) release();
		if (this.#current === turn) this.#current = undefined;
		turn.hostTools?.abort(error ?? new Error("The turn has ended."));
		if (error) turn.settle.reject(error);
		else turn.settle.resolve();
	}

	#listen(turn: Turn, signal: AbortSignal | undefined): void {
		if (!signal) return;
		if (signal.aborted) return this.#stop(turn);
		let abort = () => this.#stop(turn);
		signal.addEventListener("abort", abort, { once: true });
		turn.listeners.push(() => signal.removeEventListener("abort", abort));
	}

	#control(turn: Turn): HarnessV1PromptControl {
		return {
			submitToolResult: async ({ toolCallId, output, isError }) => {
				let toolName = turn.hostCalls.get(toolCallId);
				if (!toolName || turn.ended) return;
				turn.hostCalls.delete(toolCallId);
				let carried: ServerMessageOf<"host-tool-result"> = {
					type: "host-tool-result",
					session: this.id,
					turn: turn.id,
					toolCallId,
					output: (output ?? null) as never,
					...(isError ? { isError } : {}),
				};
				if (!encodeMessage(carried)) {
					carried = {
						...carried,
						output: hostError(`${toolName} returned more than the agent connection can carry.`),
						isError: true,
					};
				}
				let result = carried.output as NonNullable<unknown>;
				turn.emit({
					type: "tool-result",
					toolCallId,
					toolName,
					result,
					isError: carried.isError ?? isError,
				});
				if (!turn.stopped) this.#port.send(carried);
			},
			async submitToolApproval() {
				// The remote Planner asks no approvals; host tools are already allowed.
			},
			done: turn.settle.promise,
		};
	}

	async #prompt(options: PlannerTurn): Promise<HarnessV1PromptControl> {
		this.#ready();
		if (options.skills.length > 0) throw unsupported("skills");
		let takesAttachments = this.#port.features?.includes(AGENT_FEATURES.attachments) === true;
		let { prompt, attachments } = promptParts(options.prompt, takesAttachments);
		await this.#port.revalidate();
		this.#ready();
		// A client that did not ask for option previews is not offered the tool that makes their images.
		let previews = this.#port.features?.includes(AGENT_FEATURES.decisionOptionPreviews);
		let offered = options.tools.filter(tool => tool.name !== "upload_plan_image" || previews);
		let hostNames = offered.map(tool => tool.name);
		let hostTools = this.planner.hostTools;
		this.planner.hostTools = undefined;
		// The level is only ever one the client's own catalog listed for the model.
		let thinkingLevel = this.#port.features?.includes(AGENT_FEATURES.capabilityCatalog)
			? options.thinkingLevel
			: undefined;
		let turn: Turn = {
			id: crypto.randomUUID(),
			emit: options.emit,
			hostNames: new Set(hostNames),
			own: new Set(),
			ownCalls: new Set(),
			hostIds: new Set(),
			hostCalls: new Map(),
			stopped: false,
			ended: false,
			settle: Promise.withResolvers<void>(),
			...(hostTools ? { hostTools } : {}),
			listeners: [],
		};
		let sent = this.#port.send({
			type: "turn",
			session: this.id,
			turn: turn.id,
			prompt,
			...(attachments.length ? { attachments } : {}),
			...(options.instructions === undefined ? {} : { instructions: options.instructions }),
			...(options.model ? { model: options.model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			tools: offered.map(tool => ({
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
				...(tool.inputSchema === undefined
					? {}
					: { inputSchema: tool.inputSchema as Record<string, never> }),
			})),
			...(options.responseFormat
				? { responseFormat: options.responseFormat as ServerMessageOf<"turn">["responseFormat"] }
				: {}),
		});
		if (!sent) throw new Error("The agent connection could not carry this turn.");
		this.planner.activeTools = hostNames;
		this.#current = turn;
		this.#listen(turn, options.abortSignal);
		return this.#control(turn);
	}

	#ready(): void {
		if (this.#closed) throw new Error("The remote Planner session is closed.");
		if (this.#current) throw new Error("The remote Planner session already has an active turn.");
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		if (this.planner.stopping && this.#port.kept(this.id)) {
			// The server is going down and the client's work here goes on: it is neither destroyed
			// nor forgotten, so the hold the cut writes can give it back.
			let turn = this.#current;
			if (turn) {
				this.#stop(turn);
				this.#finish(turn);
			}
			this.planner.control = undefined;
			return;
		}
		this.#closed = true;
		let turn = this.#current;
		if (turn) {
			this.#stop(turn);
			this.#finish(turn);
		}
		this.planner.control = undefined;
		this.#port.send({ type: "destroy", session: this.id });
		this.#port.forget(this.id);
	}

	#session(): HarnessV1Session {
		let stopped = async (): Promise<HarnessV1ResumeSessionState> => {
			await this.close();
			return {
				type: "resume-session",
				harnessId: "remote",
				specificationVersion: "harness-v1",
				data: {},
			};
		};
		return {
			sessionId: this.id,
			isResume: false,
			doPromptTurn: options => this.#prompt(options),
			doContinueTurn: async options => {
				let turn = this.#current;
				if (!turn) throw unsupported("continuing a turn that is no longer running");
				turn.emit = options.emit;
				this.#listen(turn, options.abortSignal);
				return this.#control(turn);
			},
			doCompact: async () => {
				throw unsupported("compaction");
			},
			doSuspendTurn: async () => {
				throw unsupported("suspending a turn");
			},
			doDetach: stopped,
			doStop: stopped,
			doDestroy: () => this.close(),
		};
	}
}

/** One attached client, from its `attach` until its socket closes. */
export class AgentLink {
	#socket: LinkSocket;
	#options: LinkOptions;
	#state: "waiting" | "attaching" | "attached" | "suspended" | "closed" = "waiting";
	#channelId: string | undefined;
	#forget: ((suspended?: boolean) => void) | undefined;
	#lapse: (() => void) | undefined;
	#sessions = new Map<string, RemoteSession>();
	#inputs = new Map<string, OpenInput>();
	/** Recent `input-request` ids, oldest first, so a settled one cannot be reused. */
	#inputIds = new Set<string>();
	#controls = new Map<string, PromiseWithResolvers<void>>();
	/** Controls whose wait ended unanswered, by request, with their session: an answer may still come. */
	#late = new Map<string, string>();
	#watch: ReturnType<typeof setInterval> | undefined;
	#port: Port;
	/**
	 * Answers that arrived while the link was suspended, for the client to receive when it
	 * resumes. Each keeps its session until it is delivered or can never be.
	 */
	#outbox: Owed[] = [];
	/**
	 * Answers sent on this link that its client has not acknowledged with `input-received`, by
	 * request. One written into a socket that was already dead reaches nobody, so it is kept, with
	 * the session that waits to deliver it, until the client says it has it.
	 */
	#unacked = new Map<string, Owed>();
	/** Whether the server is shutting down: its questions are left open, as a crash leaves them. */
	#stopping = false;
	/**
	 * A same-account link that attached while this document's earlier link still counted as
	 * attached: its first message decides whether it is that client returning, and so the earlier
	 * link's connection is already dead.
	 */
	#takeover:
		| ((names: ClientMessageOf<"resume">["sessions"] | undefined) => Promise<AttachOutcome>)
		| undefined;
	#confirming = false;
	/** What the client sent while its takeover was being decided, in order. */
	#queued: ClientMessage[] = [];
	/** The link that took this suspended link's sessions; what is still sent here goes there. */
	#successor: AgentLink | undefined;
	/** Takes the sessions an earlier link kept; present until the client's first message. */
	#claim: (() => AgentLink | undefined) | undefined;
	/** Whether the client's first message, where `resume` belongs, has come. */
	#resumed = false;
	/** Whether the server or the client chose to end this link, rather than the network failing. */
	#planned = false;
	#catalog: CapabilityCatalog | undefined;
	/** Whether a turn has run without the catalog this client offered, so it is not waited for. */
	#ranWithoutCatalog = false;
	/** Set on a link rebuilt after a restart: told when its sessions are given back or end. */
	#rebuilt: { ended(): void; resumed(): void } | undefined;

	constructor(socket: LinkSocket, options: LinkOptions) {
		this.#socket = socket;
		this.#options = options;
		this.#port = {
			send: message => this.#send(message),
			control: (session, action, runId, sent) => this.#control(session, action, runId, sent),
			forget: session => {
				this.#sessions.delete(session);
				this.#cancelInputs(session);
				for (let [request, owed] of this.#unacked) {
					if (owed.session !== session) continue;
					this.#unacked.delete(request);
					owed.delivered();
				}
				this.#lapsed();
			},
			kept: session => {
				let found = this.#sessions.get(session);
				return found !== undefined && this.#keeps(found);
			},
			revalidate: () => this.#recheck(),
			timeoutMs: options.timeoutMs ?? OPERATION_TIMEOUT_MS,
			...(options.features ? { features: options.features } : {}),
		};
	}

	get channelId(): string | undefined {
		return this.#channelId;
	}

	/**
	 * A link standing in for one a process that has since restarted lost: suspended, holding the
	 * sessions, answers and Stops the cut wrote for its client, and no socket. A client's `resume`
	 * takes them from it as from any link that dropped.
	 */
	static rebuilt(
		channelId: string,
		held: PlannerHeldSession[],
		hooks: { lapse(): void; ended(): void; resumed(): void },
	): AgentLink {
		let link = new AgentLink({ send() {}, close() {} }, {
			attach: async () => ({
				ok: false,
				code: "unavailable",
				message: "This link was rebuilt after a restart.",
			}),
			features: [AGENT_FEATURES.resumableSessions],
		});
		link.#channelId = channelId;
		link.#state = "suspended";
		link.#lapse = hooks.lapse;
		link.#rebuilt = hooks;
		for (let item of held) {
			let session = new RemoteSession(item.id, { channelId, isolated: false }, link.#port);
			session.restore(item.stops);
			link.#sessions.set(item.id, session);
			for (let owed of item.owed) {
				link.#outbox.push({
					result: owed as unknown as ServerMessageOf<"input-result">,
					session: item.id,
					delivered: NO_DELIVERY,
				});
			}
			// What its client still waits on is asked of the members again once the room is open.
			for (let asked of item.asked ?? []) {
				link.#inputs.set(asked.request, {
					session: item.id,
					controller: new AbortController(),
					method: asked.method,
					decisions: [...asked.decisions],
					restored: true,
				});
			}
		}
		return link;
	}

	/**
	 * What the client keeps in this link across a restart: each session that has a live or paused
	 * run, a question it asked, or an answer it has not acknowledged, with those questions, answers
	 * and Stops. A suspended link holds only such sessions already. A question is listed with the
	 * decisions it asked, so the process that takes over can wait for their answers again.
	 */
	snapshot(): PlannerHeldSession[] {
		if (this.#state === "closed" || this.#state === "waiting" || this.#state === "attaching") {
			return [];
		}
		let suspended = this.#state === "suspended";
		let owed = [...this.#outbox, ...this.#unacked.values()];
		return [...this.#sessions.values()]
			.filter(session => suspended || this.#keeps(session))
			.map(session => {
				let inputs = [...this.#inputs].filter(([, input]) => input.session === session.id);
				let asked = inputs
					.filter(([, input]) => input.decisions.length > 0)
					.map(([request, input]) => ({
						request,
						method: input.method,
						decisions: input.decisions,
					}));
				return {
					id: session.id,
					waiting: inputs.map(([request]) => request),
					owed: owed
						.filter(item => item.session === session.id)
						.map(item => item.result as unknown as JsonValue),
					stops: session.heldStops(),
					...(asked.length > 0 ? { asked } : {}),
				};
			});
	}

	/**
	 * The room of the document is open: the questions this link's client still waits on, which a
	 * restart left open with nobody waiting, are waited on again, so that an answer a member gives
	 * goes to the client that asked, as it would have in the process that has gone.
	 */
	rejoinInputs(host: RejoinHost): void {
		if (this.#successor) return this.#successor.rejoinInputs(host);
		if (this.#state === "closed") return;
		for (let [request, input] of this.#inputs) {
			if (!input.restored || input.joined === host) continue;
			input.joined = host;
			void this.#rejoined(request, input, host);
		}
	}

	async #rejoined(request: string, input: OpenInput, host: RejoinHost): Promise<void> {
		let reply = (
			status: ServerMessageOf<"input-result">["status"],
			value?: unknown,
			text?: string,
		) => {
			if (input.joined !== host) return;
			let result: ServerMessageOf<"input-result"> = {
				type: "input-result",
				request,
				status,
				...(value === undefined ? {} : { value: value as never }),
				...(text === undefined ? {} : { message: text }),
			};
			let unsent = once(() => host.unsent(input.decisions));
			this.#answer(result, input.session, NO_DELIVERY, unsent);
		};
		try {
			let { status, value } = await host.join(
				{ method: input.method, decisions: input.decisions },
				input.controller.signal,
			);
			reply(input.controller.signal.aborted ? "cancelled" : status, value ?? null);
		} catch (error) {
			reply("failed", undefined, error instanceof Error ? error.message : String(error));
		} finally {
			if (input.joined === host && this.#inputs.get(request) === input) {
				this.#inputs.delete(request);
			}
		}
	}

	/** Whether the client's work in `session` is kept when this link drops without being ended. */
	#keeps(session: RemoteSession): boolean {
		return this.resumable && session.resumable
			&& (session.working || this.#waitingOn(session.id) > 0 || this.#owedOn(session.id) > 0);
	}

	get attached(): boolean {
		return this.#state === "attached";
	}

	/**
	 * What the client last reported with `capabilities`; absent until it does, and for a link whose
	 * client offered no `capability-catalog`.
	 */
	get catalog(): CapabilityCatalog | undefined {
		return this.#catalog;
	}

	/**
	 * Whether what the client offers is yet to be told: it offered `capability-catalog` and has not
	 * sent `capabilities`, and no turn has run without it (`settleWithoutCatalog`). A client from
	 * before the catalog never will, so nothing is pending for it, and a report that withdraws
	 * everything is still a report.
	 */
	get catalogPending(): boolean {
		return this.#catalog === undefined && !this.#ranWithoutCatalog
			&& this.#options.features?.includes(AGENT_FEATURES.capabilityCatalog) === true;
	}

	/**
	 * A turn has run, and fallen back on a saved choice, for want of the catalog this client offered
	 * and has not reported: what it offers is no longer waited for but taken as nothing, so that
	 * what the turn did can be told to the room. A report that comes later replaces it as ever.
	 */
	settleWithoutCatalog(): void {
		this.#ranWithoutCatalog = true;
	}

	/** Whether this link offered `resumable-sessions`. */
	get resumable(): boolean {
		return this.#options.features?.includes(AGENT_FEATURES.resumableSessions) === true;
	}

	/** Whether this link holds a session a `resume` names: its client is returning to it. */
	holds(sessions: ClientMessageOf<"resume">["sessions"]): boolean {
		return sessions.some(item => this.#sessions.has(item.session));
	}

	/**
	 * The server is going down. Whatever the link holds is left as a crash would leave it: no
	 * question it asked is withdrawn on the way out, so its Decisions stay open.
	 */
	shutdown(): void {
		this.#stopping = true;
		for (let session of this.#sessions.values()) session.shutdown();
	}

	/**
	 * Whether the client waits on the document's members: a question it asked is still open, or
	 * one of its workflow runs is live or paused.
	 */
	get waiting(): boolean {
		if (this.#state === "closed" || this.#state === "suspended") return false;
		if (this.#inputs.size > 0) return true;
		for (let session of this.#sessions.values()) {
			let runs = session.planner.runs;
			if (runs && (runs.active.length > 0 || runs.paused.length > 0)) return true;
		}
		return false;
	}

	/**
	 * Whether the client is in the middle of work for the document's members: a reply under way,
	 * a question still open, or a live workflow run. A paused run alone is not; it waits on people.
	 */
	get busy(): boolean {
		if (this.#state === "closed" || this.#state === "suspended") return false;
		if (this.#inputs.size > 0) return true;
		for (let session of this.#sessions.values()) {
			if (session.replying || (session.planner.runs?.active.length ?? 0) > 0) return true;
		}
		return false;
	}

	/** Opens a Planner session on the client; throws when it cannot. */
	async startSession(sessionId: string, planner: RemotePlanner): Promise<HarnessV1Session> {
		if (this.#state !== "attached") throw new Error("The agent connection is not attached.");
		if (this.#sessions.has(sessionId)) {
			throw new Error("The remote Planner session is already open.");
		}
		await this.#recheck();
		let session = new RemoteSession(sessionId, planner, this.#port);
		this.#sessions.set(sessionId, session);
		try {
			return await session.start();
		} catch (error) {
			// Withdraws any question the client asked while the session was starting.
			await session.close();
			throw error;
		}
	}

	/** Closes the link with `access-revoked` and throws when the caller may no longer be the Planner. */
	async #recheck(): Promise<void> {
		if (this.#options.revalidate && !await this.#options.revalidate()) {
			this.#refuse(
				"access-revoked",
				"The connected account can no longer act for this document.",
			);
			throw new Error("The machine can no longer act for this document.");
		}
		if (this.#state !== "attached") throw new Error("The agent connection closed.");
	}

	async #recheckAttached(): Promise<void> {
		try {
			await this.#recheck();
		} catch (error) {
			if (this.#state === "attached") console.error("[agent] access recheck failed:", error);
		}
	}

	receive(raw: unknown): void {
		if (this.#state === "closed" || this.#state === "suspended") return;
		let parsed = parseClientMessage(raw);
		if (!parsed.ok) return this.#violate(parsed.code, parsed.message);
		let message = parsed.message;
		if (this.#state !== "attached") {
			if (this.#state === "waiting" && message.type === "attach") {
				void this.#attach(message);
				return;
			}
			return this.#violate("protocol", "Send attach first, and nothing else until it is answered.");
		}
		if (this.#takeover) return this.#confirm(message);
		this.#dispatch(message);
	}

	/**
	 * The first message of a link that attached beside an earlier link of its account still
	 * counting as attached. Only a `resume` naming a session that earlier link holds shows the
	 * client is the one returning, so that link's connection is gone; anything else is a second
	 * client, refused as such.
	 */
	#confirm(message: ClientMessage): void {
		if (this.#queued.length > 0 || this.#confirming) {
			this.#queued.push(message);
			return;
		}
		this.#confirming = true;
		let takeover = this.#takeover!;
		let names = message.type === "resume" ? message.sessions : undefined;
		void takeover(names).then(outcome => {
			this.#confirming = false;
			this.#takeover = undefined;
			if (this.#state !== "attached") {
				if (outcome.ok) outcome.detach?.();
				return;
			}
			if (!outcome.ok) return this.#refuse(outcome.code, outcome.message);
			this.#bind(outcome);
			this.#dispatch(message);
			for (let later of this.#queued.splice(0)) this.#dispatch(later);
		}, error => {
			console.error("[agent] taking over an attachment failed:", error);
			this.#confirming = false;
			this.#takeover = undefined;
			this.#refuse("unavailable", "The document could not be checked.");
		});
	}

	/** Tells the client why it is no longer the Planner, then closes the link. */
	revoke(code: RefusalCode, message: string): void {
		if (this.#state === "closed" || this.#state === "suspended") return;
		this.#refuse(code, message);
	}

	/**
	 * Ends the link because the server is restarting. A client that offered `restart-notice` is
	 * told when to expect the new process first. The close is unplanned as far as the client's
	 * work is concerned, so a resumable link keeps its sessions for the client to resume.
	 */
	restart(reconnectWithinMs: number): void {
		if (this.#options.features?.includes(AGENT_FEATURES.restartNotice)) {
			this.#send({ type: "restarting", reconnectWithinMs });
		}
		this.close(LINK_CLOSE.restarting, "server restarting");
	}

	/** Ends the link from the server side. */
	close(code: number, reason: string): void {
		if (this.#state === "closed" || this.#state === "suspended") return;
		// A client the server stopped hearing from has most likely lost its network, and may
		// return; any other reason is the server's or the client's own decision to end. Decided
		// before the socket closes, as its close event may report back at once.
		this.#planned = code !== LINK_CLOSE.unresponsive && code !== LINK_CLOSE.restarting;
		try {
			this.#socket.close(code, reason);
		} finally {
			this.disconnected();
		}
	}

	/**
	 * The socket closed. Normally every open turn ends and nothing waits on this client again. A
	 * link that offered `resumable-sessions` and dropped unexpectedly instead keeps each session
	 * that has a live or paused run or an open question, for its account to resume whenever it
	 * returns, unless the server or the client ended the link itself.
	 */
	disconnected(): void {
		if (this.#state === "closed" || this.#state === "suspended") return;
		let kept = !this.#planned && this.#state === "attached"
				&& this.#options.features?.includes(AGENT_FEATURES.resumableSessions)
			? [...this.#sessions.values()].filter(session => this.#keeps(session))
			: [];
		if (kept.length) return this.#suspend(kept);
		this.#state = "closed";
		clearInterval(this.#watch);
		this.#forget?.();
		this.#forget = undefined;
		this.#teardown();
	}

	/**
	 * Every session a suspended link kept has been let go, as Stop does one that only waits on a
	 * question: nothing is left for the client to resume, so the link ends and its account holds
	 * the document only as long as any detached account does.
	 */
	#lapsed(): void {
		if (this.#state !== "suspended" || this.#sessions.size > 0) return;
		this.#state = "closed";
		this.#teardown();
		this.#lapse?.();
		this.#rebuilt?.ended();
	}

	/** Ends a suspended link for good: nothing will take back what it kept. */
	terminate(): void {
		if (this.#state !== "suspended") return;
		this.#state = "closed";
		this.#teardown();
		this.#rebuilt?.ended();
	}

	#waitingOn(session: string): number {
		let count = 0;
		for (let input of this.#inputs.values()) if (input.session === session) count++;
		return count;
	}

	/** How many answers of `session` its client has not acknowledged. */
	#owedOn(session: string): number {
		let count = 0;
		for (let owed of this.#unacked.values()) if (owed.session === session) count++;
		return count;
	}

	#suspend(kept: RemoteSession[]): void {
		this.#state = "suspended";
		clearInterval(this.#watch);
		for (let [id, session] of this.#sessions) {
			if (kept.includes(session)) {
				session.suspend();
				continue;
			}
			session.linkClosed();
			this.#sessions.delete(id);
			this.#cancelInputs(id);
		}
		for (let control of this.#controls.values()) {
			control.reject(new Error("The agent connection closed."));
		}
		this.#controls.clear();
		this.#late.clear();
		// An answer written to a link that dropped may never have arrived: it is sent again to the
		// client that returns and still waits on it.
		for (let owed of this.#unacked.values()) {
			if (this.#sessions.has(owed.session)) this.#outbox.push(owed);
			else owed.delivered();
		}
		this.#unacked.clear();
		this.#forget?.(true);
		this.#forget = undefined;
	}

	/** Every session and open question this link still holds ends, as when any link closes. */
	#teardown(): void {
		for (let session of this.#sessions.values()) session.linkClosed();
		this.#sessions.clear();
		if (!this.#stopping) { for (let input of this.#inputs.values()) input.controller.abort(); }
		this.#inputs.clear();
		for (let owed of this.#unacked.values()) {
			owed.delivered();
		}
		this.#unacked.clear();
		for (let control of this.#controls.values()) {
			control.reject(new Error("The agent connection closed."));
		}
		this.#controls.clear();
		this.#late.clear();
		// The answers waiting for a client that is not coming back can never be delivered.
		for (let { delivered, unsent } of this.#outbox.splice(0)) {
			unsent?.();
			delivered();
		}
	}

	/** The client is not taking back what an earlier link kept: it ends. */
	#abandon(): void {
		let earlier = this.#claim?.();
		this.#claim = undefined;
		earlier?.terminate();
	}

	/**
	 * The client resumes: it names the sessions it still holds and the questions each still waits
	 * on. Those sessions, with the questions that are still open or were answered meanwhile, move
	 * to this link; whatever it does not name ends. Each Stop pressed while the link was down is
	 * the first thing the client hears after `resumed`.
	 */
	#resume(message: ClientMessageOf<"resume">): void {
		let earlier = this.#claim?.();
		this.#claim = undefined;
		let held = new Map(message.sessions.map(item => [item.session, new Set(item.requests)]));
		let resumed: ServerMessageOf<"resumed">["sessions"] = [];
		let results: Owed[] = [];
		if (earlier) results = earlier.#hand(this, held, resumed);
		this.#send({ type: "resumed", sessions: resumed });
		for (let { session } of resumed) this.#sessions.get(session)?.deliverHeldStops();
		for (let { result, session, delivered } of results) this.#answer(result, session, delivered);
	}

	/** Gives `next` the sessions the client still holds; returns the answers it is still owed. */
	#hand(
		next: AgentLink,
		held: Map<string, Set<string>>,
		resumed: ServerMessageOf<"resumed">["sessions"],
	): Owed[] {
		let owed = this.#outbox;
		this.#outbox = [];
		this.#state = "closed";
		this.#successor = next;
		next.#inputs = this.#inputs;
		next.#inputIds = this.#inputIds;
		let delivered: Owed[] = [];
		for (let [id, session] of this.#sessions) {
			let waiting = held.get(id);
			if (!waiting) {
				session.linkClosed();
				this.#cancelInputs(id);
				continue;
			}
			let requests: string[] = [];
			for (let [request, input] of this.#inputs) {
				if (input.session !== id) continue;
				if (waiting.has(request)) requests.push(request);
				else {
					input.controller.abort();
					this.#inputs.delete(request);
				}
			}
			for (let answer of owed) {
				if (!waiting.has(answer.result.request)) continue;
				requests.push(answer.result.request);
				delivered.push(answer);
			}
			next.#sessions.set(id, session);
			session.rebind(next.#port);
			resumed.push({ session: id, requests });
		}
		this.#sessions.clear();
		// An answer the client does not wait for, or whose session it no longer holds, is not owed.
		for (let answer of owed) {
			if (delivered.includes(answer)) continue;
			answer.unsent?.();
			answer.delivered();
		}
		if (resumed.length > 0) this.#rebuilt?.resumed();
		else this.#rebuilt?.ended();
		return delivered;
	}

	#send(message: ServerMessage): boolean {
		if (this.#successor) return this.#successor.#send(message);
		if (this.#state === "suspended" || this.#state === "closed") return false;
		let encoded = encodeMessage(message);
		if (!encoded) return false;
		this.#socket.send(encoded);
		return true;
	}

	/**
	 * Gives the client an answer, or keeps it for the link that takes this one's sessions. Either
	 * way, `delivered` runs once the client has acknowledged it, or can never, and only then may
	 * its session be let go. A client that did not offer `resumable-sessions` cannot acknowledge,
	 * so for it the answer is delivered once it is sent.
	 */
	#answer(
		result: ServerMessageOf<"input-result">,
		session: string,
		delivered: () => void,
		unsent?: () => void,
	): void {
		if (this.#successor) return this.#successor.#answer(result, session, delivered, unsent);
		if (this.#state === "suspended") {
			this.#outbox.push({ result, session, delivered, ...(unsent ? { unsent } : {}) });
			return;
		}
		let sent = false;
		try {
			sent = this.#send(result);
		} finally {
			if (!sent) unsent?.();
			if (!sent || !this.resumable) delivered();
			else this.#awaitAck({ result, session, delivered });
		}
	}

	#awaitAck(owed: Owed): void {
		this.#unacked.set(owed.result.request, owed);
	}

	#violate(code: ProtocolErrorCode, message: string): void {
		this.#send({ type: "error", code, message });
		this.close(code === "message-too-large" ? LINK_CLOSE.tooLarge : LINK_CLOSE.malformed, code);
	}

	#refuse(code: RefusalCode, message: string): void {
		this.#send({
			type: "refused",
			code,
			message,
			...(code === "unavailable" ? { retry: true } : {}),
		});
		this.close(REFUSAL_CLOSE[code], code);
	}

	async #attach(message: ClientMessageOf<"attach">): Promise<void> {
		this.#state = "attaching";
		if (message.version !== AGENT_VERSION) {
			return this.#refuse(
				"unsupported-version",
				`This Chopin speaks agent connection version ${AGENT_VERSION}, not ${message.version}.`,
			);
		}
		let outcome: AttachOutcome;
		try {
			outcome = await this.#options.attach(message);
		} catch (error) {
			console.error("[agent] attach failed:", error);
			outcome = { ok: false, code: "unavailable", message: "The document could not be checked." };
		}
		if (this.#state !== "attaching") {
			if (outcome.ok) outcome.detach?.();
			return;
		}
		if (!outcome.ok) return this.#refuse(outcome.code, outcome.message);
		this.#channelId = outcome.document.id;
		this.#state = "attached";
		let features = this.#options.features;
		this.#send({
			type: "attached",
			version: AGENT_VERSION,
			document: outcome.document,
			...(features ? { features } : {}),
		});
		if (outcome.takeover) {
			this.#takeover = outcome.takeover;
			return;
		}
		this.#bind(outcome);
	}

	/** Makes this link the document's Planner: registered, rechecked, and able to resume. */
	#bind(outcome: Extract<AttachOutcome, { ok: true }>): void {
		let unregister = this.#options.register?.(outcome.document.id, this);
		let detach = outcome.detach;
		this.#lapse = outcome.lapse;
		this.#forget = suspended => {
			unregister?.();
			detach?.(suspended);
		};
		// Only a client that offered the feature can take back what an earlier link kept.
		if (outcome.claim && this.#options.features?.includes(AGENT_FEATURES.resumableSessions)) {
			this.#claim = outcome.claim;
		} else outcome.claim?.()?.terminate();
		this.#watch = setInterval(
			() => void this.#recheckAttached(),
			this.#options.revalidateEveryMs ?? REVALIDATE_EVERY_MS,
		);
	}

	#dispatch(message: ClientMessage): void {
		// Resuming is the first thing a client does; anything else means it holds nothing to resume.
		if (message.type !== "resume") {
			this.#resumed = true;
			this.#abandon();
		}
		switch (message.type) {
			case "resume":
				if (!this.#options.features?.includes(AGENT_FEATURES.resumableSessions)) {
					return this.#violate("protocol", "resume needs the resumable-sessions feature.");
				}
				if (this.#resumed) return this.#violate("protocol", "resume must come first, once.");
				this.#resumed = true;
				return this.#resume(message);
			case "capabilities": {
				if (!this.#options.features?.includes(AGENT_FEATURES.capabilityCatalog)) {
					return this.#violate("protocol", "capabilities needs the capability-catalog feature.");
				}
				// What nobody can ask for (a model with no id, an empty level) is left out here, once,
				// so every reader of the catalog sees only what can be chosen; the rest and the link stay.
				let { catalog, skipped } = usableCatalog(message.catalog);
				if (skipped.length > 0) {
					console.warn(
						`[agent] ${this.#channelId} reported catalog entries Chopin cannot offer; skipped:`,
						skipped.join("; "),
					);
				}
				this.#catalog = catalog;
				this.#options.catalogChanged?.();
				return;
			}
			case "attach":
				return this.#violate("protocol", "This link is already attached.");
			case "detach":
				return this.close(LINK_CLOSE.detached, "detached");
			case "started":
			case "start-failed":
				return this.#sessions.get(message.session)?.acknowledge(message);
			case "tools":
			case "part":
			case "host-tool-call":
			case "turn-end": {
				let session = this.#sessions.get(message.session);
				if (session) return session.receive(message);
				if (message.type !== "host-tool-call") return;
				this.#send({
					type: "host-tool-result",
					session: message.session,
					turn: message.turn,
					toolCallId: message.toolCallId,
					output: hostError("The session has ended."),
					isError: true,
				});
				return;
			}
			case "runs":
				return this.#sessions.get(message.session)?.reportRuns(message);
			case "control-result": {
				let control = this.#controls.get(message.request);
				this.#controls.delete(message.request);
				let late = this.#late.get(message.request);
				if (late !== undefined) {
					this.#late.delete(message.request);
					this.#sessions.get(late)?.answeredLate(message.request);
				}
				if (message.ok) control?.resolve();
				else {control?.reject(
						new ControlRefused(message.message ?? "The machine refused."),
					);}
				return;
			}
			case "input-request":
				return void this.#input(message);
			case "input-cancel":
				return this.#inputs.get(message.request)?.controller.abort();
			case "input-received": {
				if (!this.resumable) {
					return this.#violate("protocol", "input-received needs the resumable-sessions feature.");
				}
				let owed = this.#unacked.get(message.request);
				if (!owed) return;
				this.#unacked.delete(message.request);
				owed.delivered();
				return;
			}
		}
	}

	async #control(
		session: string,
		action: "stop" | "resume",
		runId?: string,
		sent?: (request: string) => void,
	): Promise<void> {
		let request = crypto.randomUUID();
		let pending = Promise.withResolvers<void>();
		this.#controls.set(request, pending);
		if (!this.#send({ type: action, request, session, ...(runId ? { run: runId } : {}) })) {
			this.#controls.delete(request);
			throw new Error("The agent connection is closed.");
		}
		sent?.(request);
		try {
			await within(
				pending.promise,
				this.#port.timeoutMs,
				`The machine did not answer ${action}.`,
			);
		} catch (error) {
			if (error instanceof Unanswered) {
				this.#late.set(request, session);
				if (this.#late.size > MAX_LATE_CONTROLS) this.#late.delete(this.#late.keys().next().value!);
			}
			throw error;
		} finally {
			this.#controls.delete(request);
		}
	}

	async #input(message: ClientMessageOf<"input-request">): Promise<void> {
		let delivered: () => void = NO_DELIVERY;
		let reply = (
			status: ServerMessageOf<"input-result">["status"],
			value?: unknown,
			text?: string,
		) =>
			this.#answer(
				{
					type: "input-result",
					request: message.request,
					status,
					...(value === undefined ? {} : { value: value as never }),
					...(text === undefined ? {} : { message: text }),
				},
				message.session,
				delivered,
			);
		if (this.#inputs.has(message.request) || this.#inputIds.has(message.request)) {
			return this.#violate("protocol", `Input request ${message.request} was repeated.`);
		}
		this.#inputIds.add(message.request);
		if (this.#inputIds.size > REMEMBERED_INPUTS) {
			this.#inputIds.delete(this.#inputIds.values().next().value!);
		}
		let session = this.#sessions.get(message.session);
		let humanInput = session?.planner.humanInput;
		if (!session || !humanInput) {
			return void reply("failed", undefined, "Decisions are not available to this session.");
		}
		if (this.#inputs.size >= MAX_OPEN_INPUTS) {
			return void reply("failed", undefined, "Too many questions are already open.");
		}
		let controller = new AbortController();
		// The session outlives the question until its answer reaches the client: an answer given
		// to a session with nothing else to keep it would otherwise find it already let go.
		delivered = session.planner.holdInput?.() ?? delivered;
		let open: OpenInput = {
			session: message.session,
			controller,
			method: message.input.method,
			decisions: [],
		};
		this.#inputs.set(message.request, open);
		if (message.workflowRunId && message.rootRunId) {
			session.rememberRoot(message.workflowRunId, message.rootRunId);
		}
		let status: HumanInputStatus = "cancelled";
		let host = humanInput(outcome => {
			status = outcome;
		});
		let options = {
			signal: controller.signal,
			requestId: message.request,
			sessionId: message.session,
			asked: (decisions: string[]) => {
				open.decisions = decisions;
			},
			...(message.workflowRunId ? { workflowRunId: message.workflowRunId } : {}),
			...(message.workflowStageId ? { workflowStageId: message.workflowStageId } : {}),
			...(message.block ? { block: message.block } : {}),
		};
		let input = message.input;
		try {
			let value = input.method === "questionnaire"
				? await host.questionnaire(input.params, options)
				: input.method === "confirm"
				? await host.confirm(input.title, input.message, options)
				: input.method === "select"
				? await host.select(input.title, input.choices, options)
				: input.method === "input"
				? await host.input(input.title, input.placeholder, options)
				: await host.editor(input.title, input.initial, options);
			reply(controller.signal.aborted ? "cancelled" : status, value ?? null);
		} catch (error) {
			reply("failed", undefined, error instanceof Error ? error.message : String(error));
		} finally {
			this.#inputs.delete(message.request);
		}
	}

	#cancelInputs(session: string): void {
		for (let [request, input] of this.#inputs) {
			if (input.session !== session) continue;
			if (!this.#stopping) input.controller.abort();
			this.#inputs.delete(request);
		}
	}
}
