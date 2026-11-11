/**
 * A minimal agent connection client. At runtime it uses only the documented wire
 * format (docs/agent-connection.md), JSON and the platform WebSocket, so it runs in
 * Bun or Node.js and shows what an external client needs.
 */

import type {
	CapabilityCatalog,
	ClientMessage,
	ClientMessageOf,
	InputCall,
	LinkRun,
	RefusalCode,
	ServerMessage,
	ServerMessageOf,
	StreamPart,
} from "./protocol";

/** The wire constants a client needs, as docs/agent-connection.md states them. */
export const WIRE = {
	path: "/api/v1/agent",
	subprotocol: "chopin.agent.v1",
	version: 1,
	maxMessageBytes: 2 * 1024 * 1024,
	maxNoteLength: 4_000,
	malformedClose: 4400,
	/** The upgrade request header asking for optional features, and the ones this client knows. */
	featuresHeader: "chopin-agent-features",
	runStageDeltas: "run-stage-deltas",
	decisionOptionPreviews: "decision-option-previews",
	resumableSessions: "resumable-sessions",
	restartNotice: "restart-notice",
	capabilityCatalog: "capability-catalog",
	attachments: "attachments",
	/** How often a client retries a `resume` refused with `retry`, after a `restarting` notice. */
	restartResumeRetryMs: 250,
} as const;

export class AgentRefused extends Error {
	readonly code: RefusalCode;
	/** Whether Chopin could not decide, so the same resumption may be tried again. */
	readonly retry: boolean;

	constructor(code: RefusalCode, message: string, retry = false) {
		super(message);
		this.name = "AgentRefused";
		this.code = code;
		this.retry = retry;
	}
}

export type TurnEnd = ClientMessageOf<"turn-end">["status"];

/** One turn the server asked the attached Planner to run. */
export type TurnContext = {
	readonly message: ServerMessageOf<"turn">;
	/** Aborted when the server aborts the turn, destroys its session, or the link closes. */
	readonly signal: AbortSignal;
	emit(part: StreamPart): void;
	/** The client's own tools this turn may call, declared before calling any. */
	offerTools(names: string[]): void;
	/**
	 * Runs one of Chopin's tools in the server, against the document. Settles with an
	 * error result once the turn is aborted, destroyed, or ended, or the link closes.
	 */
	callHostTool(toolName: string, input: unknown): Promise<HostToolResult>;
	end(status: TurnEnd, message?: string): void;
};

export type HostToolResult = { output: unknown; isError: boolean };

export type AgentHandlers = {
	/** Throw to refuse the session. */
	start?(message: ServerMessageOf<"start">): void | Promise<void>;
	/** Ends the turn as finished when it resolves without calling `end`, failed when it rejects. */
	turn(context: TurnContext): void | Promise<void>;
	destroy?(message: ServerMessageOf<"destroy">): void;
	/** Stop or resume the session's workflow runs; throw to report that it could not. */
	control?(message: ServerMessageOf<"stop"> | ServerMessageOf<"resume">): void | Promise<void>;
};

export type AgentOptions = {
	/** The Chopin origin, or the link's own `ws:`/`wss:` URL. */
	url: string | URL;
	/** A GitHub token whose account can push to or administer the document's repository. */
	token: string;
	/** The document's id or URL. */
	document: string;
	checkout?: ClientMessageOf<"attach">["checkout"];
	handlers: AgentHandlers;
	version?: number;
	/**
	 * Asks for `resumable-sessions`, unless `false`: when the link drops unexpectedly, questions
	 * still waiting on an answer stay pending instead of ending, Chopin keeps the sessions' runs
	 * and open Decisions however long the client is away, and `resumption` says what to hand the
	 * next `connectAgent` as `resume`. A client that sets `false` ends everything when its link
	 * drops, as the earlier protocol always did.
	 */
	resumable?: boolean;
	/** What a dropped link of this client held, from its `resumption`; implies `resumable`. */
	resume?: Resumption;
	/**
	 * Asks for `capability-catalog` and reports what this client offers (its models with their
	 * thinking levels) as soon as the link is attached, after any `resume`. Without it the
	 * document's composer offers no choice of model. `AgentClient.report` replaces it later.
	 */
	capabilities?: CapabilityCatalog;
	/**
	 * Asks for `attachments`: a turn then carries the images and text files sent with the message
	 * that began it (`TurnContext.message.attachments`), which a client that does not ask is never
	 * sent.
	 */
	attachments?: boolean;
};

/** A question this client asked and still waits on, which a later link may carry on. */
type PendingAsk = {
	session: string;
	settle: (message: ServerMessageOf<"input-result">) => void;
	/** Where a cancellation goes; moves to the new link when the question resumes there. */
	route: { send: (message: ClientMessage) => boolean };
	/**
	 * Whether its caller withdrew it. The server may not have heard, as the link it was sent on
	 * can be gone, so a resumed link does not name it, which withdraws it there.
	 */
	withdrawn?: true;
};

/**
 * The sessions a link that dropped unexpectedly held, and the questions each still waited on. It
 * is only a token: give it to `connectAgent` as `resume`.
 */
export type Resumption = {
	readonly sessions: ReadonlySet<string>;
	readonly asks: ReadonlyMap<string, PendingAsk>;
};

export type LinkClosed = {
	code: number;
	reason: string;
	/**
	 * Set when the server said, with `restarting` before it closed the link, that it is restarting
	 * and a new process is expected within this many milliseconds. Connect again at once, and retry
	 * a `resume` refused with `retry` every `WIRE.restartResumeRetryMs` until this time has passed,
	 * then go back to the client's own backoff.
	 */
	reconnectWithinMs?: number;
};

export type InputOptions = {
	workflowRunId?: string;
	workflowStageId?: string;
	rootRunId?: string;
	/**
	 * The block the question concerns, from the Planner's latest read of the document; its card
	 * goes beside that block. A block that has changed since leaves the card unlinked.
	 */
	block?: { index: number; digest: string };
	signal?: AbortSignal;
};

export type AgentClient = {
	readonly document: ServerMessageOf<"attached">["document"];
	/** The optional features the server accepts from this client, from `attached`. */
	readonly features: readonly string[];
	/**
	 * Settles when the link closes: with what a resumable link held when it dropped unexpectedly,
	 * or undefined when the link ended any other way, which ends every question it held.
	 */
	readonly resumption: Promise<Resumption | undefined>;
	/** Asks the document's members through Decisions. */
	ask(
		session: string,
		input: InputCall,
		options?: InputOptions,
	): Promise<ServerMessageOf<"input-result">>;
	/**
	 * Reports the session's runs. Delta cards need a server that offers `run-stage-deltas`; a
	 * report too large for one frame is sent as several, splitting the delta cards' stages.
	 */
	reportRuns(session: string, runs: { active: string[]; paused: string[]; cards: LinkRun[] }): void;
	/**
	 * Reports a changed catalog, replacing the earlier one whole. False when the server did not
	 * accept `capability-catalog` or the link is no longer open.
	 */
	report(catalog: CapabilityCatalog): boolean;
	/** Sends one message; false when the link is no longer open. */
	send(message: ClientMessage): boolean;
	detach(): Promise<LinkClosed>;
	readonly closed: Promise<LinkClosed>;
};

export function agentUrl(url: string | URL): URL {
	let target = new URL(url);
	if (target.protocol === "ws:" || target.protocol === "wss:") return target;
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new Error("The agent connection URL must be http(s) or ws(s).");
	}
	target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
	target.pathname = WIRE.path;
	target.search = "";
	target.hash = "";
	return target;
}

/** A server message, trusted for its declared shape once it is a JSON object with a type. */
function serverMessage(data: unknown): ServerMessage | undefined {
	if (typeof data !== "string") return undefined;
	try {
		let value = JSON.parse(data) as { type?: unknown } | null;
		return typeof value === "object" && value !== null && typeof value.type === "string"
			? value as ServerMessage
			: undefined;
	} catch {
		return undefined;
	}
}

/** Bun's and Node's WebSocket accept request headers; the DOM declaration does not say so. */
type HeaderWebSocket = new(
	url: URL,
	init: { headers: Record<string, string>; protocols: string[] },
) => WebSocket;

/**
 * A socket to the link URL offering the subprotocol and carrying the bearer; browsers cannot
 * send one. The socket fails to open unless the server echoes the subprotocol.
 */
export function linkSocket(
	url: URL,
	token: string,
	resumable = false,
	catalog = false,
	attachments = false,
): WebSocket {
	return new (WebSocket as unknown as HeaderWebSocket)(url, {
		headers: {
			authorization: `Bearer ${token}`,
			[WIRE.featuresHeader]: [
				WIRE.runStageDeltas,
				WIRE.decisionOptionPreviews,
				...(resumable ? [WIRE.resumableSessions, WIRE.restartNotice] : []),
				...(catalog ? [WIRE.capabilityCatalog] : []),
				...(attachments ? [WIRE.attachments] : []),
			].join(", "),
		},
		protocols: [WIRE.subprotocol],
	});
}

type RunsReport = { active: string[]; paused: string[]; cards: LinkRun[] };

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * `runs` messages that each fit a frame: every one a complete report, with the delta cards'
 * stages spread across them in order. Later parts carry every card as a delta, so a full card
 * replaces the run's stages only once.
 */
export function splitRuns(session: string, runs: RunsReport): ClientMessageOf<"runs">[] {
	let whole: ClientMessageOf<"runs"> = { type: "runs", session, ...runs };
	if (bytes(whole) <= WIRE.maxMessageBytes) return [whole];
	let pending = runs.cards.flatMap((card, index) =>
		"stagesDelta" in card
			? card.stages.map(stage => ({ index, stage, size: bytes(stage) + 1 }))
			: []
	);
	let parts: ClientMessageOf<"runs">[] = [];
	let next = 0;
	while (next < pending.length || !parts.length) {
		let cards: LinkRun[] = runs.cards.map(card => {
			if (!parts.length && !("stagesDelta" in card)) return card;
			let { earlierStages: _, ...fields } = card as Extract<LinkRun, { earlierStages?: number }>;
			return { ...fields, stagesDelta: true, stages: [] };
		});
		let size = bytes({ type: "runs", session, ...runs, cards });
		let start = next;
		while (next < pending.length && size + pending[next]!.size <= WIRE.maxMessageBytes) {
			let { index, stage, size: added } = pending[next++]!;
			cards[index]!.stages.push(stage);
			size += added;
		}
		if (next === start && next < pending.length) {
			throw new Error("A run report exceeds the agent connection's size limit.");
		}
		parts.push({ type: "runs", session, ...runs, cards });
	}
	return parts;
}

const LINK_CLOSED = "The agent connection closed.";

type TurnState = {
	controller: AbortController;
	ended: boolean;
	calls: Map<string, (result: HostToolResult) => void>;
};

function hostFailure(message: string): HostToolResult {
	return { output: { error: message }, isError: true };
}

/** Settles each question as cancelled: the link that held it is gone and nothing will answer it. */
function cancelAsks(held: Iterable<[string, PendingAsk]>): void {
	for (let [request, ask] of held) {
		ask.settle({ type: "input-result", request, status: "cancelled", message: LINK_CLOSED });
	}
}

/** Text cut to the wire's limit for `message` and error fields. */
function note(text: string): string {
	return text.length > WIRE.maxNoteLength ? text.slice(0, WIRE.maxNoteLength) : text;
}

function reason(error: unknown): string {
	return note(error instanceof Error ? error.message : String(error));
}

function settleCalls(turn: TurnState, message: string): void {
	for (let resolve of turn.calls.values()) resolve(hostFailure(message));
	turn.calls.clear();
}

/** Attaches to one document as its Planner and serves the server's requests. */
export function connectAgent(options: AgentOptions): Promise<AgentClient> {
	let resumable = options.resumable !== false || options.resume !== undefined;
	let socket = linkSocket(
		agentUrl(options.url),
		options.token,
		resumable,
		options.capabilities !== undefined,
		options.attachments === true,
	);
	let turns = new Map<string, TurnState>();
	let asks = new Map<string, PendingAsk>();
	let sessions = new Set<string>();
	let closing = Promise.withResolvers<LinkClosed>();
	let resumption = Promise.withResolvers<Resumption | undefined>();
	let attaching = Promise.withResolvers<AgentClient>();
	let attached = false;
	/** Whether the client is attached for good: `attached`, or `resumed` when it resumes. */
	let ready = false;
	/** Whether this link ended by choice or by the server's decision, so there is nothing to resume. */
	let ended = false;
	/** What the server said, just before closing, about when it expects to be back. */
	let restartWithin: number | undefined;
	let route = { send: (message: ClientMessage) => send(message) };

	function send(message: ClientMessage): boolean {
		let encoded = JSON.stringify(message);
		if (new TextEncoder().encode(encoded).byteLength > WIRE.maxMessageBytes) {
			throw new Error("The message exceeds the agent connection's size limit.");
		}
		if (socket.readyState !== WebSocket.OPEN) return false;
		socket.send(encoded);
		return true;
	}

	function runTurn(message: ServerMessageOf<"turn">): void {
		let key = `${message.session}/${message.turn}`;
		let state: TurnState = { controller: new AbortController(), ended: false, calls: new Map() };
		turns.set(key, state);
		state.controller.signal.addEventListener(
			"abort",
			() => settleCalls(state, "The turn was aborted."),
			{ once: true },
		);
		let calls = 0;
		let context: TurnContext = {
			message,
			signal: state.controller.signal,
			emit: part => {
				if (state.ended) return;
				send({
					type: "part",
					session: message.session,
					turn: message.turn,
					part: part.type === "error" ? { ...part, error: note(part.error) } : part,
				});
			},
			offerTools: names =>
				send({
					type: "tools",
					session: message.session,
					turn: message.turn,
					names,
				}),
			callHostTool: (toolName, input) => {
				if (state.ended || state.controller.signal.aborted) {
					return Promise.resolve(hostFailure("The turn has ended."));
				}
				let toolCallId = `host-${++calls}-${crypto.randomUUID()}`;
				let result = Promise.withResolvers<HostToolResult>();
				state.calls.set(toolCallId, result.resolve);
				let sent: boolean;
				try {
					sent = send({
						type: "host-tool-call",
						session: message.session,
						turn: message.turn,
						toolCallId,
						toolName,
						input: JSON.stringify(input ?? {}),
					});
				} catch (error) {
					state.calls.delete(toolCallId);
					return Promise.reject(error);
				}
				if (!sent) {
					state.calls.delete(toolCallId);
					return Promise.resolve(hostFailure(LINK_CLOSED));
				}
				return result.promise;
			},
			end: (status, text) => {
				if (state.ended) return;
				state.ended = true;
				turns.delete(key);
				settleCalls(state, "The turn has ended.");
				send({
					type: "turn-end",
					session: message.session,
					turn: message.turn,
					status,
					...(text === undefined ? {} : { message: note(text) }),
				});
			},
		};
		Promise.resolve()
			.then(() => options.handlers.turn(context))
			.then(
				() => context.end(state.controller.signal.aborted ? "aborted" : "finished"),
				error => context.end("failed", reason(error)),
			);
	}

	/**
	 * The server refused or failed the link before it was ready. What a resumption holds ends with
	 * it, except when the refusal says Chopin could not decide (`retry`): the same resumption can
	 * succeed later, so its questions stay pending for the caller to try again.
	 */
	function failAttach(retry: boolean, error: Error): void {
		ended = true;
		if (!ready && !retry) cancelAsks(options.resume?.asks ?? []);
		attaching.reject(error);
	}

	async function serve(message: ServerMessage): Promise<void> {
		switch (message.type) {
			case "start":
				try {
					await options.handlers.start?.(message);
					sessions.add(message.session);
					send({ type: "started", session: message.session });
				} catch (error) {
					send({
						type: "start-failed",
						session: message.session,
						message: reason(error),
					});
				}
				return;
			case "turn":
				return runTurn(message);
			case "abort":
				turns.get(`${message.session}/${message.turn}`)?.controller.abort();
				return;
			case "host-tool-result": {
				let calls = turns.get(`${message.session}/${message.turn}`)?.calls;
				calls?.get(message.toolCallId)?.({
					output: message.output,
					isError: message.isError ?? false,
				});
				calls?.delete(message.toolCallId);
				return;
			}
			case "input-result":
				asks.get(message.request)?.settle(message);
				asks.delete(message.request);
				// Settled now or before: either way Chopin may stop keeping the result for this client.
				if (features.includes(WIRE.resumableSessions)) {
					send({ type: "input-received", request: message.request });
				}
				return;
			case "restarting":
				restartWithin = message.reconnectWithinMs;
				return;
			case "stop":
			case "resume":
				try {
					if (!options.handlers.control) throw new Error("This Planner has no workflow runs.");
					await options.handlers.control(message);
					send({ type: "control-result", request: message.request, ok: true });
				} catch (error) {
					send({
						type: "control-result",
						request: message.request,
						ok: false,
						message: reason(error),
					});
				}
				return;
			case "destroy":
				sessions.delete(message.session);
				for (let [key, turn] of turns) {
					if (key.startsWith(`${message.session}/`)) turn.controller.abort();
				}
				options.handlers.destroy?.(message);
				return;
			case "refused":
				return failAttach(
					message.retry === true,
					new AgentRefused(message.code, message.message, message.retry === true),
				);
			case "error":
				return failAttach(false, new Error(message.message));
			case "resumed": {
				// What the server gave back resumes here; what it did not give back has ended there.
				let held = options.resume;
				let returned = new Set(message.sessions.map(item => item.session));
				for (let { session, requests } of message.sessions) {
					sessions.add(session);
					for (let request of requests) {
						let ask = held?.asks.get(request);
						if (!ask) continue;
						ask.route = route;
						asks.set(request, ask);
						// Withdrawn while this link was being resumed, so its first cancel went nowhere.
						if (ask.withdrawn) send({ type: "input-cancel", request });
					}
				}
				cancelAsks([...held?.asks ?? []].filter(([request]) => !asks.has(request)));
				for (let session of held?.sessions ?? []) {
					if (!returned.has(session)) options.handlers.destroy?.({ type: "destroy", session });
				}
				ready = true;
				attaching.resolve(client);
				return;
			}
			case "attached":
				return;
		}
	}

	let attachedDocument: ServerMessageOf<"attached">["document"] | undefined;
	let features: readonly string[] = [];
	let client: AgentClient = {
		get document() {
			return attachedDocument!;
		},
		ask(session, input, inputOptions = {}) {
			let request = crypto.randomUUID();
			let { signal, ...workflow } = inputOptions;
			let withdrawn = (text: string) =>
				Promise.resolve<ServerMessageOf<"input-result">>({
					type: "input-result",
					request,
					status: "cancelled",
					message: text,
				});
			if (signal?.aborted) return withdrawn("The question was withdrawn before it was asked.");
			let answered = Promise.withResolvers<ServerMessageOf<"input-result">>();
			let pending: PendingAsk = { session, settle: answered.resolve, route };
			asks.set(request, pending);
			let sent: boolean;
			try {
				sent = send({ type: "input-request", request, session, ...workflow, input });
			} catch (error) {
				asks.delete(request);
				return Promise.reject(error);
			}
			if (!sent) {
				asks.delete(request);
				return withdrawn(LINK_CLOSED);
			}
			let cancel = () => {
				pending.withdrawn = true;
				// A link that is down cannot carry the cancellation: the ask ends here, and the next
				// link does not name it, which withdraws it in Chopin as a cancellation would.
				if (!pending.route.send({ type: "input-cancel", request })) {
					pending.settle({
						type: "input-result",
						request,
						status: "cancelled",
						message: "The question was withdrawn while the connection was down.",
					});
				}
			};
			signal?.addEventListener("abort", cancel, { once: true });
			return answered.promise.finally(() => signal?.removeEventListener("abort", cancel));
		},
		get features() {
			return features;
		},
		resumption: resumption.promise,
		reportRuns(session, runs) {
			if (
				!features.includes(WIRE.runStageDeltas) && runs.cards.some(card => "stagesDelta" in card)
			) {
				throw new Error("This Chopin does not accept stage deltas; report full run cards.");
			}
			for (let part of splitRuns(session, runs)) send(part);
		},
		report(catalog) {
			if (!features.includes(WIRE.capabilityCatalog)) return false;
			return send({ type: "capabilities", catalog });
		},
		send,
		detach() {
			ended = true;
			send({ type: "detach" });
			return closing.promise;
		},
		closed: closing.promise,
	};
	socket.addEventListener("open", () => {
		send({
			type: "attach",
			version: options.version ?? WIRE.version,
			document: options.document,
			...(options.checkout ? { checkout: options.checkout } : {}),
		});
	});
	let released = false;
	function release(reported: LinkClosed): void {
		if (released) return;
		released = true;
		let closed = restartWithin === undefined
			? reported
			: { ...reported, reconnectWithinMs: restartWithin };
		for (let turn of turns.values()) {
			settleCalls(turn, LINK_CLOSED);
			turn.controller.abort();
		}
		turns.clear();
		if (resumable && attached && !ended && features.includes(WIRE.resumableSessions)) {
			// Unexpected: the questions stay pending for the next link to carry on. One withdrawn
			// meanwhile ended with its caller's wait; the next link just does not name it.
			cancelAsks([...asks].filter(([, ask]) => ask.withdrawn));
			resumption.resolve({ sessions: new Set(sessions), asks: new Map(asks) });
		} else {
			cancelAsks(asks);
			resumption.resolve(undefined);
		}
		asks = new Map();
		attaching.reject(
			new Error(`The agent connection closed before attaching (${closed.code} ${closed.reason}).`),
		);
		closing.resolve(closed);
	}
	socket.addEventListener("message", event => {
		if (released) return;
		let message = serverMessage(event.data);
		if (!message) {
			let closed = { code: WIRE.malformedClose, reason: "malformed-message" };
			// A link that sends what cannot be read ends for good, whatever it kept.
			ended = true;
			if (!ready) cancelAsks(options.resume?.asks ?? []);
			socket.close(closed.code, closed.reason);
			release(closed);
			return;
		}
		if (!attached) {
			if (message.type === "attached") {
				attached = true;
				attachedDocument = message.document;
				features = message.features ?? [];
				if (features.includes(WIRE.resumableSessions)) {
					// The first message of a resumable link: what this client still holds.
					let held = options.resume;
					let requests = new Map<string, string[]>();
					for (let [request, ask] of held?.asks ?? []) {
						if (ask.withdrawn) continue;
						requests.set(ask.session, [...requests.get(ask.session) ?? [], request]);
					}
					send({
						type: "resume",
						sessions: [...held?.sessions ?? []].map(session => ({
							session,
							requests: requests.get(session) ?? [],
						})),
					});
				} else {
					cancelAsks(options.resume?.asks ?? []);
					ready = true;
					attaching.resolve(client);
				}
				// After the `resume`, which must be a resumable link's first message.
				if (options.capabilities) client.report(options.capabilities);
			} else if (message.type === "refused") {
				failAttach(
					message.retry === true,
					new AgentRefused(message.code, message.message, message.retry === true),
				);
			}
			return;
		}
		void serve(message);
	});
	socket.addEventListener("close", event => release({ code: event.code, reason: event.reason }));
	return attaching.promise;
}
