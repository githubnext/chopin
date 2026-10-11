/**
 * The server end of one Planner link: a client attached to a document whose
 * model runs Planner turns. Each Planner session Chopin opens becomes a
 * `start`, each turn a `turn`; the client streams parts back and calls
 * Chopin's host tools, which still run here against the room.
 */

import { HarnessCapabilityUnsupportedError } from "@ai-sdk/harness";
import {
	encodeMessage,
	LINK_CLOSE,
	parseClientMessage,
	PLANNER_LINK_VERSION,
} from "@chopin/planner-link";

import type {
	HarnessV1PromptControl,
	HarnessV1PromptTurnOptions,
	HarnessV1ResumeSessionState,
	HarnessV1Session,
	HarnessV1StreamPart,
} from "@ai-sdk/harness";
import type {
	ClientMessage,
	ClientMessageOf,
	ProtocolErrorCode,
	RefusalCode,
	ServerMessage,
	ServerMessageOf,
} from "@chopin/planner-link";
import type { HumanInputStatus } from "../atomic/human-input";
import type { RemotePlanner } from "./registry";

const OPERATION_TIMEOUT_MS = 10_000;
const REVALIDATE_EVERY_MS = 5 * 60_000;
const MAX_OPEN_INPUTS = 16;
const LIVE_RUN = new Set(["running", "waiting", "paused"]);

export type LinkSocket = {
	send(text: string): void;
	close(code: number, reason: string): void;
};

export type AttachOutcome =
	| { ok: true; document: ServerMessageOf<"attached">["document"] }
	| { ok: false; code: RefusalCode; message: string };

export type LinkOptions = {
	/** Resolves the document the client asked for, refusing what its caller cannot read. */
	attach(message: ClientMessageOf<"attach">): Promise<AttachOutcome>;
	/** Rechecks the caller's access; false closes the link. */
	revalidate?(): Promise<boolean>;
	/** Records the attached link and returns how to forget it. */
	register?(channelId: string, link: PlannerLink): () => void;
	timeoutMs?: number;
	/** How often an attached link's access is rechecked while it stays open. */
	revalidateEveryMs?: number;
};

const REFUSAL_CLOSE: Record<RefusalCode, number> = {
	"unsupported-version": LINK_CLOSE.unsupportedVersion,
	"repository-forbidden": LINK_CLOSE.forbidden,
	"access-revoked": LINK_CLOSE.forbidden,
	"document-unavailable": LINK_CLOSE.unavailable,
	"document-archived": LINK_CLOSE.unavailable,
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

function within<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

function promptText(prompt: HarnessV1PromptTurnOptions["prompt"]): string {
	if (typeof prompt === "string") return prompt;
	if (typeof prompt.content === "string") return prompt.content;
	return prompt.content.map(part => {
		if (part.type !== "text") throw unsupported(`${part.type} prompt parts`);
		return part.text;
	}).join("\n\n");
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
	control(session: string, action: "stop" | "resume", runId?: string): Promise<void>;
	forget(session: string): void;
	/** Throws, closing the link, when the caller can no longer read the document. */
	revalidate(): Promise<void>;
	timeoutMs: number;
};

type Turn = {
	id: string;
	emit: (part: HarnessV1StreamPart) => void;
	hostNames: Set<string>;
	own: Set<string>;
	ownCalls: Set<string>;
	/** Every host call id the turn has used, so none runs twice. */
	hostIds: Set<string>;
	hostCalls: Map<string, string>;
	stopped: boolean;
	ended: boolean;
	settle: PromiseWithResolvers<void>;
	grace?: ReturnType<typeof setTimeout>;
	listeners: (() => void)[];
};

type TurnMessage = ClientMessageOf<"tools" | "part" | "host-tool-call" | "turn-end">;

/** One Planner session whose turns run in the attached client. */
class RemoteSession {
	readonly id: string;
	readonly planner: RemotePlanner;
	#port: Port;
	#started = Promise.withResolvers<void>();
	#current: Turn | undefined;
	#closed = false;
	#roots = new Map<string, string>();

	constructor(id: string, planner: RemotePlanner, port: Port) {
		this.id = id;
		this.planner = planner;
		this.#port = port;
		void this.#started.promise.catch(() => {});
	}

	async start(): Promise<HarnessV1Session> {
		let mode = this.planner.isolated ? "isolated" as const : "planner" as const;
		if (!this.#port.send({ type: "start", session: this.id, mode })) {
			throw new Error("The Planner link is closed.");
		}
		await within(
			this.#started.promise,
			this.#port.timeoutMs,
			"The attached Planner did not start the session.",
		);
		this.planner.control = (action, runId) => this.#port.control(this.id, action, runId);
		this.planner.rootOf = runId => this.#roots.get(runId) ?? runId;
		return this.#session();
	}

	acknowledge(message: ClientMessageOf<"started" | "start-failed">): void {
		if (message.type === "started") this.#started.resolve();
		else {this.#started.reject(
				new Error(`The attached Planner refused the session: ${message.message}`),
			);}
	}

	/** The root run a workflow question belongs to, so a paused root holds its answers. */
	rememberRoot(runId: string, rootRunId: string): void {
		this.#roots.set(runId, rootRunId);
	}

	reportRuns(message: Pick<ClientMessageOf<"runs">, "active" | "paused" | "cards">): void {
		if (this.#closed || this.planner.isolated) return;
		this.planner.runs = { active: message.active, paused: message.paused, cards: message.cards };
		this.planner.onRuns?.(this.planner.runs);
		for (let wake of this.planner.waiters ?? []) wake();
	}

	/** The link is gone: nothing more will arrive for this session. */
	linkClosed(): void {
		this.#started.reject(new Error("The Planner link closed."));
		let reported = this.planner.runs;
		if (reported) {
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
				turn.stopped ? undefined : new Error("The attached Planner disconnected during the turn."),
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
							? "The attached Planner stopped the turn."
							: "The attached Planner's turn failed."),
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
				new ToolBoundaryError(`The attached Planner redefined Chopin's ${clash.join(", ")}.`),
			);
		}
		turn.own = new Set(names);
		this.planner.activeTools = [...turn.hostNames, ...names];
	}

	#hostCall(turn: Turn, message: ClientMessageOf<"host-tool-call">): void {
		if (!turn.hostNames.has(message.toolName)) {
			return this.#refuseHostCall(turn, message, "unavailable");
		}
		if (turn.hostIds.has(message.toolCallId) || turn.ownCalls.has(message.toolCallId)) {
			return this.#fail(turn, new Error(`Tool call ${message.toolCallId} was repeated.`));
		}
		turn.hostIds.add(message.toolCallId);
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

	#part(turn: Turn, part: LinkPart): void {
		let boundary = (name: string) =>
			this.#fail(turn, new ToolBoundaryError(`Planner tool boundary failure: ${name}`));
		switch (part.type) {
			case "tool-input-start":
				if (turn.hostNames.has(part.toolName)) {
					let { providerExecuted: _executed, dynamic: _dynamic, ...host } = part;
					return turn.emit(host);
				}
				if (!turn.own.has(part.toolName)) return boundary(part.toolName);
				return turn.emit({ ...part, providerExecuted: true, dynamic: true });
			case "tool-call":
				if (!turn.own.has(part.toolName) || turn.hostIds.has(part.toolCallId)) {
					return boundary(part.toolName);
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
						output: hostError(`${toolName} returned more than the Planner link can carry.`),
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

	async #prompt(options: HarnessV1PromptTurnOptions): Promise<HarnessV1PromptControl> {
		this.#ready();
		if (options.skills.length > 0) throw unsupported("skills");
		let prompt = promptText(options.prompt);
		await this.#port.revalidate();
		this.#ready();
		let hostNames = options.tools.map(tool => tool.name);
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
			listeners: [],
		};
		let sent = this.#port.send({
			type: "turn",
			session: this.id,
			turn: turn.id,
			prompt,
			...(options.instructions === undefined ? {} : { instructions: options.instructions }),
			...(options.model ? { model: options.model } : {}),
			tools: options.tools.map(tool => ({
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
		if (!sent) throw new Error("The Planner link could not carry this turn.");
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
export class PlannerLink {
	#socket: LinkSocket;
	#options: LinkOptions;
	#state: "waiting" | "attaching" | "attached" | "closed" = "waiting";
	#channelId: string | undefined;
	#forget: (() => void) | undefined;
	#sessions = new Map<string, RemoteSession>();
	#inputs = new Map<string, { session: string; controller: AbortController }>();
	#controls = new Map<string, PromiseWithResolvers<void>>();
	#watch: ReturnType<typeof setInterval> | undefined;
	#port: Port;

	constructor(socket: LinkSocket, options: LinkOptions) {
		this.#socket = socket;
		this.#options = options;
		this.#port = {
			send: message => this.#send(message),
			control: (session, action, runId) => this.#control(session, action, runId),
			forget: session => {
				this.#sessions.delete(session);
				this.#cancelInputs(session);
			},
			revalidate: () => this.#recheck(),
			timeoutMs: options.timeoutMs ?? OPERATION_TIMEOUT_MS,
		};
	}

	get channelId(): string | undefined {
		return this.#channelId;
	}

	get attached(): boolean {
		return this.#state === "attached";
	}

	/** Opens a Planner session on the client; throws when it cannot. */
	async startSession(sessionId: string, planner: RemotePlanner): Promise<HarnessV1Session> {
		if (this.#state !== "attached") throw new Error("The Planner link is not attached.");
		if (this.#sessions.has(sessionId)) {
			throw new Error("The remote Planner session is already open.");
		}
		await this.#recheck();
		let session = new RemoteSession(sessionId, planner, this.#port);
		this.#sessions.set(sessionId, session);
		try {
			return await session.start();
		} catch (error) {
			this.#sessions.delete(sessionId);
			this.#send({ type: "destroy", session: sessionId });
			throw error;
		}
	}

	/** Closes the link with `access-revoked` and throws when the caller can no longer read the document. */
	async #recheck(): Promise<void> {
		if (this.#options.revalidate && !await this.#options.revalidate()) {
			this.#refuse("access-revoked", "The attached account can no longer read this document.");
			throw new Error("The attached Planner can no longer read this document.");
		}
		if (this.#state !== "attached") throw new Error("The Planner link closed.");
	}

	async #recheckAttached(): Promise<void> {
		try {
			await this.#recheck();
		} catch (error) {
			if (this.#state === "attached") console.error("[planner-link] access recheck failed:", error);
		}
	}

	receive(raw: unknown): void {
		if (this.#state === "closed") return;
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
		this.#dispatch(message);
	}

	/** Ends the link from the server side. */
	close(code: number, reason: string): void {
		if (this.#state === "closed") return;
		try {
			this.#socket.close(code, reason);
		} finally {
			this.disconnected();
		}
	}

	/** The socket closed: every open turn ends, and nothing waits on this client again. */
	disconnected(): void {
		if (this.#state === "closed") return;
		this.#state = "closed";
		clearInterval(this.#watch);
		this.#forget?.();
		this.#forget = undefined;
		for (let session of this.#sessions.values()) session.linkClosed();
		this.#sessions.clear();
		for (let input of this.#inputs.values()) input.controller.abort();
		this.#inputs.clear();
		for (let control of this.#controls.values()) {
			control.reject(new Error("The Planner link closed."));
		}
		this.#controls.clear();
	}

	#send(message: ServerMessage): boolean {
		if (this.#state === "closed") return false;
		let encoded = encodeMessage(message);
		if (!encoded) return false;
		this.#socket.send(encoded);
		return true;
	}

	#violate(code: ProtocolErrorCode, message: string): void {
		this.#send({ type: "error", code, message });
		this.close(code === "message-too-large" ? LINK_CLOSE.tooLarge : LINK_CLOSE.malformed, code);
	}

	#refuse(code: RefusalCode, message: string): void {
		this.#send({ type: "refused", code, message });
		this.close(REFUSAL_CLOSE[code], code);
	}

	async #attach(message: ClientMessageOf<"attach">): Promise<void> {
		this.#state = "attaching";
		if (message.version !== PLANNER_LINK_VERSION) {
			return this.#refuse(
				"unsupported-version",
				`This Chopin speaks Planner link version ${PLANNER_LINK_VERSION}, not ${message.version}.`,
			);
		}
		let outcome: AttachOutcome;
		try {
			outcome = await this.#options.attach(message);
		} catch (error) {
			console.error("[planner-link] attach failed:", error);
			outcome = { ok: false, code: "unavailable", message: "The document could not be checked." };
		}
		if (this.#state !== "attaching") return;
		if (!outcome.ok) return this.#refuse(outcome.code, outcome.message);
		this.#channelId = outcome.document.id;
		this.#state = "attached";
		this.#send({ type: "attached", version: PLANNER_LINK_VERSION, document: outcome.document });
		this.#forget = this.#options.register?.(outcome.document.id, this);
		this.#watch = setInterval(
			() => void this.#recheckAttached(),
			this.#options.revalidateEveryMs ?? REVALIDATE_EVERY_MS,
		);
	}

	#dispatch(message: ClientMessage): void {
		switch (message.type) {
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
				if (message.ok) control?.resolve();
				else control?.reject(new Error(message.message ?? "The attached Planner refused."));
				return;
			}
			case "input-request":
				return void this.#input(message);
			case "input-cancel":
				return this.#inputs.get(message.request)?.controller.abort();
		}
	}

	async #control(session: string, action: "stop" | "resume", runId?: string): Promise<void> {
		let request = crypto.randomUUID();
		let pending = Promise.withResolvers<void>();
		this.#controls.set(request, pending);
		if (!this.#send({ type: action, request, session, ...(runId ? { run: runId } : {}) })) {
			this.#controls.delete(request);
			throw new Error("The Planner link is closed.");
		}
		try {
			await within(
				pending.promise,
				this.#port.timeoutMs,
				`The attached Planner did not answer ${action}.`,
			);
		} finally {
			this.#controls.delete(request);
		}
	}

	async #input(message: ClientMessageOf<"input-request">): Promise<void> {
		let reply = (
			status: ServerMessageOf<"input-result">["status"],
			value?: unknown,
			text?: string,
		) =>
			this.#send({
				type: "input-result",
				request: message.request,
				status,
				...(value === undefined ? {} : { value: value as never }),
				...(text === undefined ? {} : { message: text }),
			});
		if (this.#inputs.has(message.request)) {
			return this.#violate("protocol", `Input request ${message.request} was repeated.`);
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
		this.#inputs.set(message.request, { session: message.session, controller });
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
			...(message.workflowRunId ? { workflowRunId: message.workflowRunId } : {}),
			...(message.workflowStageId ? { workflowStageId: message.workflowStageId } : {}),
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
			input.controller.abort();
			this.#inputs.delete(request);
		}
	}
}
