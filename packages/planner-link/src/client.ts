/**
 * A minimal Planner link client. At runtime it uses only the documented wire
 * format (docs/planner-link.md), JSON and the platform WebSocket, so it runs in
 * Bun or Node.js and shows what an external client needs.
 */

import type {
	ClientMessage,
	ClientMessageOf,
	InputCall,
	LinkRun,
	RefusalCode,
	ServerMessage,
	ServerMessageOf,
	StreamPart,
} from "./protocol";

/** The wire constants a client needs, as docs/planner-link.md states them. */
export const WIRE = {
	path: "/planner-link",
	version: 1,
	maxMessageBytes: 2 * 1024 * 1024,
	maxNoteLength: 4_000,
	malformedClose: 4400,
} as const;

export class PlannerLinkRefused extends Error {
	readonly code: RefusalCode;

	constructor(code: RefusalCode, message: string) {
		super(message);
		this.name = "PlannerLinkRefused";
		this.code = code;
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

export type PlannerLinkHandlers = {
	/** Throw to refuse the session. */
	start?(message: ServerMessageOf<"start">): void | Promise<void>;
	/** Ends the turn as finished when it resolves without calling `end`, failed when it rejects. */
	turn(context: TurnContext): void | Promise<void>;
	destroy?(message: ServerMessageOf<"destroy">): void;
	/** Stop or resume the session's workflow runs; throw to report that it could not. */
	control?(message: ServerMessageOf<"stop"> | ServerMessageOf<"resume">): void | Promise<void>;
};

export type PlannerLinkOptions = {
	/** The Chopin origin, or the link's own `ws:`/`wss:` URL. */
	url: string | URL;
	/** A GitHub token whose account can push to or administer the document's repository. */
	token: string;
	/** The document's id or URL. */
	document: string;
	checkout?: ClientMessageOf<"attach">["checkout"];
	handlers: PlannerLinkHandlers;
	version?: number;
};

export type LinkClosed = { code: number; reason: string };

export type InputOptions = {
	workflowRunId?: string;
	workflowStageId?: string;
	rootRunId?: string;
	signal?: AbortSignal;
};

export type PlannerLinkClient = {
	readonly document: ServerMessageOf<"attached">["document"];
	/** Asks the document's members through Decisions. */
	ask(
		session: string,
		input: InputCall,
		options?: InputOptions,
	): Promise<ServerMessageOf<"input-result">>;
	reportRuns(session: string, runs: { active: string[]; paused: string[]; cards: LinkRun[] }): void;
	/** Sends one message; false when the link is no longer open. */
	send(message: ClientMessage): boolean;
	detach(): Promise<LinkClosed>;
	readonly closed: Promise<LinkClosed>;
};

export function plannerLinkUrl(url: string | URL): URL {
	let target = new URL(url);
	if (target.protocol === "ws:" || target.protocol === "wss:") return target;
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new Error("The Planner link URL must be http(s) or ws(s).");
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
type HeaderWebSocket = new(url: URL, init: { headers: Record<string, string> }) => WebSocket;

/** A socket to the link URL carrying the bearer; browsers cannot send one. */
export function linkSocket(url: URL, token: string): WebSocket {
	return new (WebSocket as unknown as HeaderWebSocket)(url, {
		headers: { authorization: `Bearer ${token}` },
	});
}

const LINK_CLOSED = "The Planner link closed.";

type TurnState = {
	controller: AbortController;
	ended: boolean;
	calls: Map<string, (result: HostToolResult) => void>;
};

function hostFailure(message: string): HostToolResult {
	return { output: { error: message }, isError: true };
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
export function connectPlannerLink(options: PlannerLinkOptions): Promise<PlannerLinkClient> {
	let socket = linkSocket(plannerLinkUrl(options.url), options.token);
	let turns = new Map<string, TurnState>();
	let asks = new Map<string, (message: ServerMessageOf<"input-result">) => void>();
	let closing = Promise.withResolvers<LinkClosed>();
	let attaching = Promise.withResolvers<PlannerLinkClient>();
	let attached = false;

	function send(message: ClientMessage): boolean {
		let encoded = JSON.stringify(message);
		if (new TextEncoder().encode(encoded).byteLength > WIRE.maxMessageBytes) {
			throw new Error("The message exceeds the Planner link's size limit.");
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

	async function serve(message: ServerMessage): Promise<void> {
		switch (message.type) {
			case "start":
				try {
					await options.handlers.start?.(message);
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
				asks.get(message.request)?.(message);
				asks.delete(message.request);
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
				for (let [key, turn] of turns) {
					if (key.startsWith(`${message.session}/`)) turn.controller.abort();
				}
				options.handlers.destroy?.(message);
				return;
			case "attached":
			case "refused":
			case "error":
				return;
		}
	}

	let attachedDocument: ServerMessageOf<"attached">["document"] | undefined;
	let client: PlannerLinkClient = {
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
			asks.set(request, answered.resolve);
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
			let cancel = () => send({ type: "input-cancel", request });
			signal?.addEventListener("abort", cancel, { once: true });
			return answered.promise.finally(() => signal?.removeEventListener("abort", cancel));
		},
		reportRuns(session, runs) {
			send({ type: "runs", session, ...runs });
		},
		send,
		detach() {
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
	function release(closed: LinkClosed): void {
		if (released) return;
		released = true;
		for (let turn of turns.values()) {
			settleCalls(turn, LINK_CLOSED);
			turn.controller.abort();
		}
		turns.clear();
		for (let [request, resolve] of asks) {
			resolve({ type: "input-result", request, status: "cancelled", message: LINK_CLOSED });
		}
		asks.clear();
		attaching.reject(
			new Error(`The Planner link closed before attaching (${closed.code} ${closed.reason}).`),
		);
		closing.resolve(closed);
	}
	socket.addEventListener("message", event => {
		if (released) return;
		let message = serverMessage(event.data);
		if (!message) {
			let closed = { code: WIRE.malformedClose, reason: "malformed-message" };
			socket.close(closed.code, closed.reason);
			release(closed);
			return;
		}
		if (!attached) {
			if (message.type === "attached") {
				attached = true;
				attachedDocument = message.document;
				attaching.resolve(client);
			} else if (message.type === "refused") {
				attaching.reject(new PlannerLinkRefused(message.code, message.message));
			}
			return;
		}
		void serve(message);
	});
	socket.addEventListener("close", event => release({ code: event.code, reason: event.reason }));
	return attaching.promise;
}
