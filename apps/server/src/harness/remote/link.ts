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
import { AI_RENEW_BEFORE_MS, AiLaunchRefused } from "../../ai/launches";
import { AI_ACCOUNT_UNCHECKED_SESSION, NO_AI_ACCOUNT_SESSION } from "../../ai/account-check";

import type {
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
	HarnessV1ResumeSessionState,
	HarnessV1Session,
	HarnessV1StreamPart,
} from "@ai-sdk/harness";
import type {
	AiGrants,
	CapabilityCatalog,
	ClientMessage,
	ClientMessageOf,
	ProtocolErrorCode,
	RefusalCode,
	ServerMessage,
	ServerMessageOf,
	TurnAttachment,
} from "@chopin/agent-link";
import type { JsonValue, PlannerHeldSession } from "../../storage/model";
import { withdrawnValue } from "../atomic/human-input";
import type { AskedInput, HumanInput, HumanInputStatus, InputMethod } from "../atomic/human-input";
import type { PlannerTurn } from "../turn-level";
import type { RemotePlanner } from "./registry";

const OPERATION_TIMEOUT_MS = 10_000;
/** How soon a renewal of a session's AI launch that failed is tried again. */
const AI_RETRY_MS = 60_000;
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

/**
 * The AI launches of a link's sessions, all for the person the link acts for. Given only to a
 * link whose client offered `ai-credentials`.
 */
export type LinkAi = {
	/**
	 * Prepares a launch for a session of the document, owned by the session: what the runner is
	 * handed, and the id that ends it. Throws `AiLaunchRefused` when it would be given nothing (no AI
	 * account Chopin can use, or the launch ended first), and another error when it could not be
	 * prepared now. A launch handed out with no provider (an earlier Chopin's) is never started on.
	 */
	launch(channelId: string, sessionId: string): Promise<{ launchId?: string; grants: AiGrants }>;
	/**
	 * Prepares the link's catalog launch (`ai-catalog`), owned by the link `linkId`: the proxy lets
	 * it list each provider's models and read the model catalog, and refuses it everything else.
	 * Throws as `launch` does.
	 */
	catalog?(channelId: string, linkId: string): Promise<{ launchId?: string; grants: AiGrants }>;
	end(launchId: string): void;
	/** Calls `changed` whenever the person's AI credentials change; returns how to stop. */
	watch(changed: () => void): () => void;
	/** Hears that a session holds a launch now, or no longer does (see `Port.aiHeld`). */
	held?(launchId: string, holding: boolean): void;
};

/**
 * A session's start or fork refused because its launch would be given no provider: the account it
 * is for has no AI account Chopin can use. Its turn says so in these words, with `code`.
 */
export class NoAiAccountError extends Error {
	override name = "NoAiAccountError";
	readonly code = "no-ai-account" as const;
}

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
	/** Launches the sessions' AI, once the client offered `ai-credentials`. */
	ai?: LinkAi;
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
	/** Gives the client's running `turn` a person's message; rejects when it could not take it. */
	steer(session: string, turn: string, prompt: string): Promise<void>;
	/** Withdraws the questions asked while `turn` ran. */
	withdraw(session: string, turn: string): void;
	forget(session: string): void;
	/** Whether the client's work in `session` goes on past a restart: it is kept, not destroyed. */
	kept(session: string): boolean;
	/** Throws, closing the link, when the caller can no longer read the document. */
	revalidate(): Promise<void>;
	timeoutMs: number;
	/** The features the client asked for that this server supports; absent when it asked for none. */
	features?: readonly string[];
	/** The sessions' AI launches, when the client offered `ai-credentials`. */
	ai?: LinkAi;
	/**
	 * Ends a session's AI launch: present wherever launches are handed out, whatever the client
	 * offers, so a launch a session kept across a restart ends with it.
	 */
	endAi?: (launchId: string) => void;
	/**
	 * Hears that a session holds an AI launch now (`holding`), or no longer does: what says a
	 * session's launch is still owned, so one no session holds is ended (see `AiCredentials.retire`).
	 */
	aiHeld?: (launchId: string, holding: boolean) => void;
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
	withdrawn: boolean;
	ended: boolean;
	settle: PromiseWithResolvers<void>;
	/** Aborted when the turn ends, so the server's host tools still running for it stop too. */
	hostTools?: AbortController;
	grace?: ReturnType<typeof setTimeout>;
	listeners: (() => void)[];
};

type TurnMessage = ClientMessageOf<"tools" | "part" | "host-tool-call" | "turn-end">;

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
	/** The turn that ran when it was asked: Chopin stopping that turn withdraws it. */
	turn?: string;
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
	/** Whether the document this host asks in is still open; absent, it is. */
	live?(): boolean;
	/**
	 * Asks the document's members, as Decisions, a question a rebuilt session's client asks after
	 * the restart. No turn of this process opened that session, so nothing else can.
	 */
	humanInput?(report: (status: HumanInputStatus) => void): HumanInput;
};

/**
 * What a session a restart rebuilt needs to reach its document: the host of the document's room
 * while it is open, and a way to open it for as long as a question waits.
 */
export type RebuiltDocument = {
	host?: RejoinHost;
	/** Opens the document and keeps it open until the returned function is called. */
	open?: () => Promise<() => void>;
};

const METHODS = ["questionnaire", "confirm", "select", "input", "editor"] as const;

/**
 * Decisions for a session a restart rebuilt. Each question opens the document, or keeps the open
 * one, for as long as it waits, and is asked through the host of its room, so a question the
 * client asks after the restart becomes a Decision as one asked before it did.
 */
function rebuiltInput(
	document: RebuiltDocument,
	report: (status: HumanInputStatus) => void,
): HumanInput {
	let live = () => {
		let host = document.host;
		return host?.humanInput && host.live?.() !== false ? host : undefined;
	};
	let through = async (ask: (input: HumanInput) => Promise<unknown>): Promise<unknown> => {
		let release = document.open ? await document.open() : undefined;
		try {
			let host = live();
			if (!host) throw new Error("Decisions are not available to this session.");
			return await ask(host.humanInput!(report));
		} finally {
			release?.();
		}
	};
	return Object.fromEntries(
		METHODS.map(method => [
			method,
			(...args: unknown[]) =>
				through(input => (input[method] as (...args: unknown[]) => Promise<unknown>)(...args)),
		]),
	) as HumanInput;
}

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
	/** The session's AI launch: the one the client holds, ended when the session is. */
	#launchId: string | undefined;
	/** When the AI launch is next prepared again, ahead of its deadline or after a failure. */
	#renewal: ReturnType<typeof setTimeout> | undefined;
	/** Stops hearing of the person's credential changes. */
	#unwatch: (() => void) | undefined;
	/** The renewal under way, so renewals run one at a time. */
	#renewing: Promise<void> = Promise.resolve();
	/**
	 * The person's AI accounts changed before the client acknowledged `start` or `fork`: the
	 * acknowledgement prepares the session's launch again, once, from what they have then.
	 */
	#aiDirty = false;
	/**
	 * A restart's hold named the session's launch: it changes no more here, and a launch prepared
	 * for it meanwhile is ended unsent, so the hold names the very launch its client holds.
	 */
	#aiFrozen = false;

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

	/** The id of the turn under way, if one is. */
	get turn(): string | undefined {
		let turn = this.#current;
		return turn && !turn.ended ? turn.id : undefined;
	}

	get withdrawing(): boolean {
		let turn = this.#current;
		return turn !== undefined && turn.withdrawn && !turn.ended;
	}

	async start(): Promise<HarnessV1Session> {
		let mode = this.planner.isolated ? "isolated" as const : "planner" as const;
		let forkFrom = this.#port.features?.includes(AGENT_FEATURES.sessionForks)
			? this.planner.forkFrom
			: undefined;
		let choice = this.#port.features?.includes(AGENT_FEATURES.sessionChoice)
				&& this.#port.features.includes(AGENT_FEATURES.capabilityCatalog)
			? this.planner.choice
			: undefined;
		let ai = await this.#launch();
		let chosen = {
			...(choice?.model ? { model: choice.model } : {}),
			...(choice?.thinkingLevel ? { thinkingLevel: choice.thinkingLevel } : {}),
			...(ai ? { ai } : {}),
		};
		let message = forkFrom
			? { type: "fork" as const, session: this.id, mode, from: forkFrom, ...chosen }
			: { type: "start" as const, session: this.id, mode, ...chosen };
		if (!this.#port.send(message)) {
			this.#releaseAi();
			throw new Error("The agent connection is closed.");
		}
		await within(
			this.#started.promise,
			this.#port.timeoutMs,
			"The machine did not start the session.",
		);
		if (forkFrom) this.planner.forkedNatively = true;
		return this.#session();
	}

	acknowledge(message: ClientMessageOf<"started" | "start-failed">): void {
		if (message.type === "started") {
			this.#acknowledged = true;
			this.#started.resolve();
			// What changed while the session was starting reaches it now, once, as it is now.
			if (this.#aiDirty) {
				this.#aiDirty = false;
				this.renewAi();
			}
		} else {this.#started.reject(
				new Error(`The machine refused the session: ${message.message}`),
			);}
	}

	/** Whether the client could take the session back: it started, and is not an isolated job. */
	get resumable(): boolean {
		return this.#acknowledged && !this.#closed && !this.planner.isolated;
	}

	/**
	 * The link dropped unexpectedly and the session waits for its client to come back. The turn
	 * under way fails, as it always did, and its host tools stop; the session and its open
	 * questions are left exactly as they were.
	 */
	suspend(): void {
		// A server going down is not the client dropping: the session is not suspended.
		if (!this.planner.stopping) this.planner.suspended = true;
		let turn = this.#current;
		if (turn) {
			this.#finish(
				turn,
				turn.stopped ? undefined : new Error("The machine disconnected during the turn."),
			);
		}
	}

	/** The server is going down: nothing is reported about this session from here on. */
	shutdown(): void {
		this.planner.stopping = true;
	}

	/**
	 * Prepares the session's AI launch for `start` or `fork`, and keeps it current: prepared again
	 * before its deadline and whenever the person's credentials change, a change while it starts
	 * included. Undefined when the client did not offer `ai-credentials`. A launch that would be
	 * given no provider starts nothing: the start is refused, as a message from someone with no AI
	 * account is (`NoAiAccountError`), and no `start` or `fork` is sent.
	 */
	async #launch(): Promise<AiGrants | undefined> {
		let ai = this.#port.ai;
		if (!ai) return undefined;
		this.#unwatch ??= ai.watch(() => this.renewAi());
		let launched: { launchId?: string; grants: AiGrants };
		try {
			launched = await ai.launch(this.planner.channelId, this.id);
		} catch (error) {
			this.#releaseAi();
			if (error instanceof AiLaunchRefused && error.code === "no-ai-account") {
				throw new NoAiAccountError(
					error.unchecked ? AI_ACCOUNT_UNCHECKED_SESSION : NO_AI_ACCOUNT_SESSION,
				);
			}
			throw error;
		}
		if (this.#closed) {
			if (launched.launchId) ai.end(launched.launchId);
			throw new Error("The agent connection is closed.");
		}
		if (!launched.grants.providers.length) {
			if (launched.launchId) ai.end(launched.launchId);
			this.#releaseAi();
			throw new NoAiAccountError(NO_AI_ACCOUNT_SESSION);
		}
		this.#adopt(ai, launched);
		return launched.grants;
	}

	#adopt(ai: LinkAi, launched: { launchId?: string; grants: AiGrants }): void {
		let previous = this.#launchId;
		this.#holding(launched.launchId);
		if (previous && previous !== launched.launchId) ai.end(previous);
		this.#unwatch ??= ai.watch(() => this.renewAi());
		let { expiresAt } = launched.grants;
		if (expiresAt !== undefined) this.#renewAt(expiresAt - AI_RENEW_BEFORE_MS - Date.now());
		else clearTimeout(this.#renewal);
	}

	/** The session holds `launchId` now, in place of any it held, as `aiHeld` hears. */
	#holding(launchId: string | undefined): void {
		let previous = this.#launchId;
		if (previous === launchId) return;
		this.#launchId = launchId;
		if (launchId) this.#port.aiHeld?.(launchId, true);
		if (previous) this.#port.aiHeld?.(previous, false);
	}

	#renewAt(delay: number): void {
		clearTimeout(this.#renewal);
		this.#renewal = setTimeout(() => this.renewAi(), Math.min(Math.max(delay, 0), 2 ** 31 - 1));
		this.#renewal.unref?.();
	}

	/**
	 * Prepares the session's AI launch again and hands the client the new grants in `ai`; the earlier
	 * launch ends once they are sent. A link that is down sends nothing and keeps the earlier launch,
	 * for its client's return to renew; a launch that could not be prepared is tried again soon.
	 */
	renewAi(): void {
		if (!this.#acknowledged && !this.#closed && !this.#aiFrozen) {
			this.#aiDirty = true;
			return;
		}
		this.#renewing = this.#renewing.then(async () => {
			let ai = this.#port.ai;
			if (this.#closed || this.#aiFrozen) return;
			if (!ai) {
				this.#releaseAi();
				return;
			}
			let launched: { launchId?: string; grants: AiGrants };
			try {
				launched = await ai.launch(this.planner.channelId, this.id);
			} catch (error) {
				if (error instanceof AiLaunchRefused) {
					// Nothing is left to give it: the session hears it has no grant now, and its launch ends.
					launched = { grants: { providers: [], withheld: error.withheld } };
				} else {
					console.error("[agent] a session's AI launch could not be prepared again:", error);
					this.#renewAt(AI_RETRY_MS);
					return;
				}
			}
			// Frozen for a restart's hold meanwhile: the hold names the launch the client holds, so this
			// one is never sent.
			if (
				this.#closed || this.#aiFrozen
				|| !this.#port.send({ type: "ai", session: this.id, ai: launched.grants })
			) {
				if (launched.launchId) ai.end(launched.launchId);
				return;
			}
			this.#adopt(ai, launched);
		});
	}

	/**
	 * A restart's hold is about to name the session's launch: it changes no more in this process, and
	 * a renewal under way ends what it prepared rather than send it.
	 */
	freezeAi(): void {
		this.#aiFrozen = true;
		this.#aiDirty = false;
		clearTimeout(this.#renewal);
		this.#renewal = undefined;
		this.#unwatch?.();
		this.#unwatch = undefined;
	}

	/**
	 * Ends the session's AI launch, or, when `ended` is false, only stops keeping it current: the
	 * launch stays the session's, for a hold to keep and the next process to end or replace.
	 */
	#releaseAi(ended = true): void {
		clearTimeout(this.#renewal);
		this.#renewal = undefined;
		this.#unwatch?.();
		this.#unwatch = undefined;
		if (!ended) return;
		let launchId = this.#launchId;
		this.#holding(undefined);
		if (launchId) this.#port.endAi?.(launchId);
	}

	/** The id of the session's AI launch, for a hold to keep across a restart. */
	get aiLaunchId(): string | undefined {
		return this.#launchId;
	}

	/** The client is back on another link, which carries the session from here on. */
	rebind(port: Port): void {
		this.#port = port;
		this.planner.suspended = false;
	}

	/**
	 * A session a process that has since restarted kept for its client: the client started it, and
	 * its link is down. Its AI launch is the session's again, ended when the session ends or the
	 * client's return replaces it.
	 */
	restore(aiLaunchId?: string): void {
		this.#acknowledged = true;
		this.#holding(aiLaunchId);
		this.planner.suspended = true;
	}

	/** The link is gone for good: nothing more will arrive for this session. */
	linkClosed(): void {
		// A session the cut keeps for its client keeps its launch, which the hold names.
		let held = this.planner.stopping === true && this.#port.kept(this.id);
		this.planner.suspended = false;
		this.#started.reject(new Error("The agent connection closed."));
		let turn = this.#current;
		if (turn) {
			this.#finish(
				turn,
				turn.stopped ? undefined : new Error("The machine disconnected during the turn."),
			);
		}
		this.#closed = true;
		this.#releaseAi(!held);
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
			case "compacting":
				return turn.emit({ type: "raw", rawValue: { type: "compacting" } });
			case "finish-step":
				if (part.usage.contextWindow !== undefined) {
					turn.emit({
						type: "raw",
						rawValue: { type: "context-window", contextWindow: part.usage.contextWindow },
					});
				}
				return turn.emit({
					type: "finish-step",
					finishReason: finishReason(part.finishReason),
					usage: usage(part.usage),
				});
			case "finish":
				if (part.totalUsage.contextWindow !== undefined) {
					turn.emit({
						type: "raw",
						rawValue: { type: "context-window", contextWindow: part.totalUsage.contextWindow },
					});
				}
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

	/**
	 * Chopin stopped the turn. A question it asked for itself ends with it, as a full Atomic
	 * Planner's does, so neither its card nor the session stays behind waiting on it. A server
	 * that is restarting withdraws nothing.
	 */
	#stopped(turn: Turn): void {
		if (!turn.stopped && !turn.ended && !this.planner.stopping) {
			turn.withdrawn = true;
			this.#port.withdraw(this.id, turn.id);
		}
		this.#stop(turn);
	}

	#listen(turn: Turn, signal: AbortSignal | undefined): void {
		if (!signal) return;
		if (signal.aborted) return this.#stopped(turn);
		let abort = () => this.#stopped(turn);
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
			// Only a client that offered `steer-turn` is sent a `steer`, so only its turns take a message.
			...(this.#port.features?.includes(AGENT_FEATURES.steerTurn)
				? {
					submitUserMessage: async (text: string) => {
						if (turn.ended || turn.stopped || this.#current !== turn) {
							throw new Error("The turn is not running.");
						}
						await this.#port.steer(this.id, turn.id, text);
					},
				}
				: {}),
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
		let answers = this.#port.features?.includes(AGENT_FEATURES.retryTurn)
			? this.planner.turnMessage
			: undefined;
		this.planner.turnMessage = undefined;
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
			withdrawn: false,
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
			...(answers
				? { message: answers.id, ...(answers.retry ? { retry: true as const } : {}) }
				: {}),
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
		this.planner.onRemoteTurn?.({ session: this.id, turn: turn.id });
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
			// Its launch stays the session's, for the hold: the next process ends it, or replaces it once
			// the client resumes.
			this.#releaseAi(false);
			return;
		}
		this.#closed = true;
		let turn = this.#current;
		if (turn) {
			this.#stop(turn);
			this.#finish(turn);
		}
		this.#releaseAi();
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
	/** The steers sent and not yet answered, by request. */
	#controls = new Map<string, PromiseWithResolvers<void>>();
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
	/** Settles once nothing is pending: the client reported, a turn ran without it, or the link ended. */
	#offered = Promise.withResolvers<void>();
	/** What owns the link's catalog launch: `link:<this>`, whose end ends it. */
	readonly #id = crypto.randomUUID();
	/**
	 * The link's catalog launch, once its client asked for one (`ai-catalog`): the launch it holds,
	 * its renewal, how to stop watching the person's credentials, and the preparation under way.
	 */
	#catalogAi:
		| {
			launchId?: string;
			renewal?: ReturnType<typeof setTimeout>;
			unwatch: () => void;
			work: Promise<void>;
		}
		| undefined;

	constructor(socket: LinkSocket, options: LinkOptions) {
		this.#socket = socket;
		this.#options = options;
		this.#port = {
			send: message => this.#send(message),
			steer: (session, turn, prompt) => this.#steer(session, turn, prompt),
			withdraw: (session, turn) => {
				for (let [request, input] of this.#inputs) {
					if (input.session !== session || input.turn !== turn) continue;
					input.controller.abort();
					this.#inputs.delete(request);
				}
			},
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
			...(options.ai && options.features?.includes(AGENT_FEATURES.aiCredentials)
				? { ai: options.ai }
				: {}),
			...(options.ai ? { endAi: (launchId: string) => options.ai!.end(launchId) } : {}),
			...(options.ai?.held
				? { aiHeld: (launchId: string, holding: boolean) => options.ai!.held!(launchId, holding) }
				: {}),
		};
	}

	get channelId(): string | undefined {
		return this.#channelId;
	}

	/**
	 * A link standing in for one a process that has since restarted lost: suspended, holding the
	 * sessions and answers the cut wrote for its client, and no socket. A client's `resume`
	 * takes them from it as from any link that dropped.
	 */
	static rebuilt(
		channelId: string,
		held: PlannerHeldSession[],
		hooks: {
			lapse(): void;
			/** Opens the document for a question its client asks, until the returned function is called. */
			open?: () => Promise<() => void>;
			/** Ends an AI launch a held session kept, once nothing will take it back. */
			endAi?: (launchId: string) => void;
			/** Hears that a held session holds an AI launch, or no longer does. */
			aiHeld?: (launchId: string, holding: boolean) => void;
		},
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
		if (hooks.endAi) link.#port.endAi = hooks.endAi;
		if (hooks.aiHeld) link.#port.aiHeld = hooks.aiHeld;
		for (let item of held) {
			// No turn of this process opens the session, so it reaches its document through the room's
			// host: what its client asks after the restart is asked as before.
			let document: RebuiltDocument = hooks.open ? { open: hooks.open } : {};
			let planner: RemotePlanner = { channelId, isolated: false, rebuilt: document };
			planner.humanInput = report => rebuiltInput(document, report);
			let session = new RemoteSession(item.id, planner, link.#port);
			session.restore(item.aiLaunchId);
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
	 * A restart's hold is about to name each session's AI launch: none changes any more here (see
	 * `RemoteSession.freezeAi`).
	 */
	freezeAi(): void {
		for (let session of this.#sessions.values()) session.freezeAi();
	}

	/**
	 * What the client keeps in this link across a restart: each session that has a question it
	 * asked, or an answer it has not acknowledged, with those questions and answers. A suspended link holds only such sessions already. A question is listed with the
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
					// An earlier release reads it on a rollback; nothing is held for it now.
					stops: [],
					...(asked.length > 0 ? { asked } : {}),
					...(session.aiLaunchId ? { aiLaunchId: session.aiLaunchId } : {}),
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
		// A session the restart rebuilt asks through this room from now on.
		for (let session of this.#sessions.values()) {
			let rebuilt = session.planner.rebuilt;
			if (rebuilt) rebuilt.host = host;
		}
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
			&& (this.#waitingOn(session.id) > 0 || this.#owedOn(session.id) > 0);
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

	/** Whether the client offered `steer-turn`: a message for a running turn can reach it. */
	get steers(): boolean {
		return this.#options.features?.includes(AGENT_FEATURES.steerTurn) === true;
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
		this.#offered.resolve();
	}

	/**
	 * Settles when what the client offers is no longer pending (`catalogPending`): it reported, a
	 * turn ran without it, or the link ended. Already settled for a client that offered no catalog.
	 */
	get offered(): Promise<void> {
		if (!this.catalogPending) return Promise.resolve();
		return this.#offered.promise;
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

	/** Whether the client waits on the document's members: a question it asked is still open. */
	get waiting(): boolean {
		if (this.#state === "closed" || this.#state === "suspended") return false;
		return this.#inputs.size > 0;
	}

	/**
	 * Whether the client is in the middle of work for the document's members: a reply under way, or
	 * a question still open.
	 */
	get busy(): boolean {
		if (this.#state === "closed" || this.#state === "suspended") return false;
		if (this.#inputs.size > 0) return true;
		for (let session of this.#sessions.values()) if (session.replying) return true;
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
			await session.close();
			// When a client refuses `fork` (e.g. parent session evicted), fall back to `start`.
			if (
				planner.forkFrom
				&& this.#state === "attached"
				&& error instanceof Error
				&& error.message.startsWith("The machine refused the session:")
			) {
				planner.forkFrom = undefined;
				planner.forkedNatively = false;
				let fallback = new RemoteSession(sessionId, planner, this.#port);
				this.#sessions.set(sessionId, fallback);
				try {
					return await fallback.start();
				} catch (retryError) {
					await fallback.close();
					throw retryError;
				}
			}
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
		// The catalog launch is the link's: it ends with the link, whatever its sessions keep.
		this.#endCatalog();
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
	}

	/** Ends a suspended link for good: nothing will take back what it kept. */
	terminate(): void {
		if (this.#state !== "suspended") return;
		this.#state = "closed";
		this.#teardown();
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
		this.#offered.resolve();
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
	 * to this link; whatever it does not name ends.
	 */
	#resume(message: ClientMessageOf<"resume">): void {
		let earlier = this.#claim?.();
		this.#claim = undefined;
		let held = new Map(message.sessions.map(item => [item.session, new Set(item.requests)]));
		let resumed: ServerMessageOf<"resumed">["sessions"] = [];
		let results: Owed[] = [];
		if (earlier) results = earlier.#hand(this, held, resumed);
		this.#send({ type: "resumed", sessions: resumed });
		// The launch a resumed session held may have ended with its link, or with the process.
		for (let { session } of resumed) this.#sessions.get(session)?.renewAi();
		for (let { result, session, delivered } of results) this.#answer(result, session, delivered);
	}

	/**
	 * The client asked for the link's catalog grants: they are handed out now and again whenever
	 * the person's credentials change or the launch nears its deadline, until the link ends. A link
	 * whose client did not offer `ai-credentials`, or a server that hands out no launches, is sent
	 * none; asking again changes nothing.
	 */
	#askCatalog(): void {
		let ai = this.#port.ai;
		if (!ai?.catalog || this.#catalogAi || this.#state !== "attached") return;
		this.#catalogAi = { unwatch: ai.watch(() => this.#renewCatalog()), work: Promise.resolve() };
		this.#renewCatalog();
	}

	/**
	 * Prepares the link's catalog launch, and in the same step as it is sent, once the link is
	 * still attached, holds it and ends the one it replaces; a launch the link can no longer take is
	 * ended unsent. Nothing left to give hands the client an empty `providers`. One at a time.
	 */
	#renewCatalog(): void {
		let held = this.#catalogAi;
		let ai = this.#port.ai;
		if (!held || !ai?.catalog) return;
		let catalog = ai.catalog.bind(ai);
		held.work = held.work.then(async () => {
			if (this.#catalogAi !== held || this.#state !== "attached") return;
			let launched: { launchId?: string; grants: AiGrants };
			try {
				launched = await catalog(this.#channelId!, this.#id);
			} catch (error) {
				if (!(error instanceof AiLaunchRefused)) {
					console.error("[agent] a link's catalog launch could not be prepared:", error);
					this.#renewCatalogAt(AI_RETRY_MS);
					return;
				}
				launched = { grants: { providers: [], withheld: error.withheld } };
			}
			if (launched.launchId && !launched.grants.providers.length) {
				ai.end(launched.launchId);
				launched = { grants: { providers: [], withheld: launched.grants.withheld } };
			}
			if (this.#catalogAi !== held || this.#state !== "attached") {
				if (launched.launchId) ai.end(launched.launchId);
				return;
			}
			// Held before it is sent, so the client's first request finds its owner live.
			if (launched.launchId) ai.held?.(launched.launchId, true);
			if (!this.#send({ type: "ai-catalog", ai: launched.grants })) {
				if (launched.launchId) {
					ai.held?.(launched.launchId, false);
					ai.end(launched.launchId);
				}
				return;
			}
			let previous = held.launchId;
			held.launchId = launched.launchId;
			if (previous && previous !== launched.launchId) {
				ai.held?.(previous, false);
				ai.end(previous);
			}
			let { expiresAt } = launched.grants;
			if (expiresAt !== undefined) {
				this.#renewCatalogAt(expiresAt - AI_RENEW_BEFORE_MS - Date.now());
			} else clearTimeout(held.renewal);
		}).catch(error =>
			console.error("[agent] a link's catalog launch could not be handed out:", error)
		);
	}

	#renewCatalogAt(delay: number): void {
		let held = this.#catalogAi;
		if (!held) return;
		clearTimeout(held.renewal);
		held.renewal = setTimeout(
			() => this.#renewCatalog(),
			Math.min(Math.max(delay, 0), 2 ** 31 - 1),
		);
		held.renewal.unref?.();
	}

	/** Ends the link's catalog launch, in force the moment it is asked, and stops renewing it. */
	#endCatalog(): void {
		let held = this.#catalogAi;
		if (!held) return;
		this.#catalogAi = undefined;
		clearTimeout(held.renewal);
		held.unwatch();
		let ai = this.#port.ai;
		if (held.launchId) {
			ai?.held?.(held.launchId, false);
			ai?.end(held.launchId);
		}
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
		this.#offered.resolve();
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
				this.#offered.resolve();
				this.#options.catalogChanged?.();
				return;
			}
			case "ai-catalog":
				if (!this.#options.features?.includes(AGENT_FEATURES.aiCatalog)) {
					return this.#violate("protocol", "ai-catalog needs the ai-catalog feature.");
				}
				return this.#askCatalog();
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
			case "control-result": {
				let control = this.#controls.get(message.request);
				this.#controls.delete(message.request);
				if (message.ok) control?.resolve();
				else control?.reject(new Error(message.message ?? "The machine refused."));
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

	/** A person's message for a running turn, answered by the client's `control-result`. */
	async #steer(session: string, turn: string, prompt: string): Promise<void> {
		let request = crypto.randomUUID();
		let pending = Promise.withResolvers<void>();
		this.#controls.set(request, pending);
		if (!this.#send({ type: "steer", request, session, turn, prompt })) {
			this.#controls.delete(request);
			throw new Error("The agent connection is closed.");
		}
		try {
			await within(
				pending.promise,
				this.#port.timeoutMs,
				"The machine did not answer a message sent to its turn.",
			);
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
		if (session.withdrawing) {
			return void reply("cancelled", withdrawnValue(message.input.method));
		}
		if (this.#inputs.size >= MAX_OPEN_INPUTS) {
			return void reply("failed", undefined, "Too many questions are already open.");
		}
		let controller = new AbortController();
		// The session outlives the question until its answer reaches the client: an answer given
		// to a session with nothing else to keep it would otherwise find it already let go.
		delivered = session.planner.holdInput?.() ?? delivered;
		let asking = session.turn;
		let open: OpenInput = {
			session: message.session,
			...(asking ? { turn: asking } : {}),
			controller,
			method: message.input.method,
			decisions: [],
		};
		this.#inputs.set(message.request, open);
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
