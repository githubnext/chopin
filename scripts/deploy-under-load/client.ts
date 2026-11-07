/**
 * A person's tab, without the page: a signed-in socket to one document that types into a
 * paragraph of its own, keeps what the server has not acknowledged and sends it again when it is
 * back, and comes back after a loss on the ladder a tab uses (`ladder.ts`). It is the wire
 * (`apps/web/src/wire.ts`) and the document provider (`packages/editor/src/provider.ts`) as far as
 * a restart can tell them apart, which is what a deploy under load is about.
 */
import { typingPeer, Y } from "../../apps/server/src/testing/typing-peer";
import { lossOf, next } from "./ladder";

import type { TypingPeer } from "../../apps/server/src/testing/typing-peer";
import type { Request, RequestKind } from "./analysis";

/** A tab says nothing for this long after a loss. */
export const GRACE_MS = 1_500;
/** An update not acknowledged in this long is sent again, as the provider does. */
const RESEND_MS = 2_000;

export type Attempt = {
	/** When the attempt started, after the loss. */
	offsetMs: number;
	/** How long the upgrade took, if the socket opened. */
	upgradeMs?: number;
	opened: boolean;
	/** The status of the probe that preceded it, if there was one. */
	probe?: number;
};

export type Loss = {
	code: number;
	/** Whether the server said it is restarting, by the close code or by `session:restarting`. */
	announced: boolean;
	lostAt: number;
	/** When the socket that got the document back opened. */
	socketOpenedAt?: number;
	/** When the document was open again: the socket open and its state exchanged. */
	reopenedAt?: number;
	attempts: Attempt[];
};

type Frame = { kind: string; rid?: string; [key: string]: unknown };

class Lost extends Error {}

export type ClientOptions = {
	origin: string;
	cookie: string;
	document: string;
	/** The marker of the paragraph this client types into, which is also its name. */
	marker: string;
	/** How long between words. */
	typeMs: number;
	/** The spread of a tab's first attempt after a restart it was told of; the tab's own if absent. */
	jitterMs?: number;
};

/** Bun's WebSocket takes the headers of the handshake, which the DOM's type does not know. */
const HeadedWebSocket = WebSocket as unknown as new(
	url: string,
	options: { headers: Record<string, string> },
) => WebSocket;

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const decode = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

export class EditorClient {
	readonly marker: string;
	/** Every word typed, in order. */
	readonly tokens: string[] = [];
	readonly losses: Loss[] = [];
	/** What the server said about the document being replaced under this client, and when. */
	readonly resets: Array<{ at: number; reason: string }> = [];
	acknowledged = 0;
	/** How long each update took from first being sent to being acknowledged. */
	readonly ackMs: number[] = [];
	/** The same, with when each was acknowledged. */
	readonly acks: Array<{ at: number; ms: number }> = [];
	maxOutbox = 0;
	revision = 0;
	/** The threads the server told this client about, for finding a note it may already have saved. */
	threads: Array<{ notes: Array<{ text: string }> }> = [];

	readonly #options: ClientOptions;
	readonly #peer: TypingPeer = typingPeer();
	readonly #pending = new Map<
		string,
		{ resolve: (frame: Frame) => void; reject: (error: Error) => void }
	>();
	readonly #outbox = new Map<string, Uint8Array>();
	readonly #sentAt = new Map<string, number>();
	readonly #firstSentAt = new Map<string, number>();
	#socket: WebSocket | undefined;
	#epoch: string | undefined;
	#synced = false;
	#stopped = false;
	#announced = false;
	#counter = 0;
	#timers: Array<ReturnType<typeof setInterval>> = [];
	#waiting: Array<() => void> = [];
	#typing = false;

	constructor(options: ClientOptions) {
		this.#options = options;
		this.marker = options.marker;
		this.#peer.onLocal(update => {
			let id = `${this.marker}-${this.#counter++}`;
			this.#outbox.set(id, update);
			this.maxOutbox = Math.max(this.maxOutbox, this.#outbox.size);
			if (this.#synced) this.#send(id);
		});
	}

	get synced(): boolean {
		return this.#synced;
	}

	/** Words typed that the server has not acknowledged. */
	get unacknowledged(): number {
		return this.#outbox.size;
	}

	/** The document's current revision, as the page reads it from the implementation snapshot. */
	async planRevision(): Promise<number> {
		let response = await fetch(
			`${this.#options.origin}/api/channels/${this.#options.document}/implementation`,
			{ headers: { cookie: this.#options.cookie }, signal: AbortSignal.timeout(20_000) },
		);
		return Number(((await response.json()) as { planRevision?: number }).planRevision);
	}

	/** Opens the socket and the document; resolves once the document is open the first time. */
	async start(): Promise<void> {
		this.#connect(undefined);
		await this.whenSynced();
		this.#timers.push(setInterval(() => this.#resend(), 500));
	}

	/** Types a word every `typeMs`, as a person does, until stopped. */
	typeContinuously(): void {
		let loop = async () => {
			while (!this.#stopped && this.#typing) {
				let token = `${this.marker.replace("ed", "e")}n${this.tokens.length}`;
				this.tokens.push(token);
				this.#peer.type(this.marker, token);
				await Bun.sleep(this.#options.typeMs * (0.5 + Math.random()));
			}
		};
		this.#typing = true;
		void loop();
	}

	stopTyping(): void {
		this.#typing = false;
	}

	/** Resolves when every word typed has been acknowledged, or after `ms`. */
	async drain(ms: number): Promise<boolean> {
		let deadline = performance.now() + ms;
		while (performance.now() < deadline) {
			if (this.#outbox.size === 0 && this.#synced) return true;
			await Bun.sleep(25);
		}
		return false;
	}

	async whenSynced(ms = 30_000): Promise<void> {
		if (this.#synced) return;
		await new Promise<void>((resolve, reject) => {
			let timer = setTimeout(
				() => reject(new Error(`${this.marker} was not synced in ${ms} ms`)),
				ms,
			);
			this.#waiting.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	stop(): void {
		this.#stopped = true;
		this.#typing = false;
		for (let timer of this.#timers) clearInterval(timer);
		for (let waiting of this.#pending.values()) waiting.reject(new Lost("stopped"));
		this.#pending.clear();
		this.#socket?.close(1000);
		this.#socket = undefined;
		this.#peer.destroy();
	}

	/** One request answered by one frame, which the connection's loss ends with `Lost`. */
	ask(kind: string, payload: Record<string, unknown> = {}, ms = 20_000): Promise<Frame> {
		let socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN || !this.#synced) {
			return Promise.reject(new Lost("not connected"));
		}
		let rid = crypto.randomUUID().slice(0, 8);
		return new Promise<Frame>((resolve, reject) => {
			let timer = setTimeout(() => {
				this.#pending.delete(rid);
				reject(new Lost("no answer"));
			}, ms);
			this.#pending.set(rid, {
				resolve: frame => {
					clearTimeout(timer);
					resolve(frame);
				},
				reject: error => {
					clearTimeout(timer);
					reject(error);
				},
			});
			socket.send(JSON.stringify({ ...payload, kind, ts: Math.floor(Date.now() / 1000), rid }));
		});
	}

	/**
	 * A Planner request, sent again with the same identity while the connection is lost and until it
	 * is acknowledged, as a tab's outbox does. `send` makes the frame and says whether a note it
	 * may already have saved is among the threads the server last told this client about.
	 */
	async request(
		kind: RequestKind,
		tag: string | undefined,
		document: string,
		send: () => Promise<{ frame: string; payload: Record<string, unknown>; saved?: () => boolean }>,
	): Promise<Request> {
		let record: Request = {
			kind,
			document,
			tag,
			acknowledged: false,
			retries: 0,
			sentAt: performance.now(),
		};
		let deadline = performance.now() + 60_000;
		let first = true;
		while (!this.#stopped && performance.now() < deadline) {
			await this.whenSynced(60_000).catch(() => {});
			let { frame, payload, saved } = await send();
			if (!first && saved?.()) {
				record.acknowledged = true;
				record.ackedAt = performance.now();
				return record;
			}
			first = false;
			try {
				let answer = await this.ask(frame, payload);
				if (answer.kind === "session:error") {
					record.refusal = String(answer.code ?? answer.message);
					// The document moved on between reading its revision and asking: read it again.
					if (/revision/.test(String(answer.message)) && record.retries < 5) {
						record.retries++;
						record.refusal = undefined;
						continue;
					}
					return record;
				}
				if (answer.ok === false) {
					record.refusal = String(answer.code ?? answer.reason);
					return record;
				}
				record.acknowledged = true;
				record.queued = answer.queued === true || answer.planner === "queued"
					|| answer.state === "queued";
				record.ackedAt = performance.now();
				return record;
			} catch (error) {
				if (!(error instanceof Lost)) throw error;
				record.retries++;
				await Bun.sleep(100);
			}
		}
		record.refusal ??= "no answer";
		return record;
	}

	#endpoint(): string {
		let url = new URL("/ws", this.#options.origin);
		url.protocol = "ws:";
		url.searchParams.set("channel", this.#options.document);
		return url.href;
	}

	async #probe(): Promise<number | undefined> {
		try {
			let response = await fetch(this.#endpoint().replace(/^ws/, "http"), {
				headers: { "x-chopin-socket-probe": "1", cookie: this.#options.cookie },
				signal: AbortSignal.timeout(4_000),
			});
			return response.status;
		} catch {
			return undefined;
		}
	}

	/** Starts one attempt; `loss` is the outage it belongs to, with its attempts so far. */
	#connect(loss: Loss | undefined): void {
		if (this.#stopped) return;
		let startedAt = performance.now();
		let attempt: Attempt | undefined = loss
			? { offsetMs: Math.round(startedAt - loss.lostAt), opened: false }
			: undefined;
		if (loss && attempt) loss.attempts.push(attempt);
		let socket = new HeadedWebSocket(this.#endpoint(), {
			headers: { cookie: this.#options.cookie, origin: this.#options.origin },
		});
		this.#socket = socket;
		this.#announced = false;
		socket.addEventListener("open", () => {
			if (this.#socket !== socket) return;
			if (attempt) {
				attempt.opened = true;
				attempt.upgradeMs = Math.round(performance.now() - startedAt);
			}
			if (loss) loss.socketOpenedAt = performance.now();
			void this.#open(socket, loss);
		});
		socket.addEventListener("message", event => {
			if (this.#socket === socket && typeof event.data === "string") this.#receive(event.data);
		});
		socket.addEventListener("close", event => {
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			this.#synced = false;
			for (let waiting of this.#pending.values()) waiting.reject(new Lost("connection lost"));
			this.#pending.clear();
			if (this.#stopped) return;
			let announced = this.#announced;
			let kind = lossOf(event.code, announced);
			let current: Loss;
			if (loss && loss.reopenedAt === undefined) {
				current = loss;
				current.announced ||= kind === "restart";
			} else {
				current = {
					code: event.code,
					announced: kind === "restart",
					lostAt: performance.now(),
					attempts: [],
				};
				this.losses.push(current);
			}
			void this.#retry(current);
		});
	}

	async #retry(loss: Loss): Promise<void> {
		let plan = next({
			restarting: loss.announced,
			attempts: loss.attempts.length,
			lostAt: loss.lostAt,
			now: performance.now(),
			random: Math.random,
			jitterMs: this.#options.jitterMs,
		});
		if (plan.probe) {
			let status = await this.#probe();
			let last = loss.attempts.at(-1);
			if (last) last.probe = status;
		}
		await Bun.sleep(plan.delayMs);
		this.#connect(loss);
	}

	async #open(socket: WebSocket, loss: Loss | undefined): Promise<void> {
		let resume = this.#epoch
			? { epoch: this.#epoch, vector: encode(Y.encodeStateVector(this.#peer.doc)) }
			: {};
		let reply: Frame;
		try {
			let rid = crypto.randomUUID().slice(0, 8);
			reply = await new Promise<Frame>((resolve, reject) => {
				this.#pending.set(rid, { resolve, reject });
				socket.send(
					JSON.stringify({ ...resume, kind: "plan:open", ts: Math.floor(Date.now() / 1000), rid }),
				);
			});
		} catch {
			return;
		}
		if (this.#socket !== socket) return;
		if (reply.kind === "session:error") {
			this.resets.push({ at: performance.now(), reason: `open refused: ${String(reply.message)}` });
			return;
		}
		let epoch = String(reply.epoch);
		if (this.#epoch !== undefined && this.#epoch !== epoch) {
			this.resets.push({ at: performance.now(), reason: "replaced" });
			this.#outbox.clear();
		}
		this.#epoch = epoch;
		this.revision = Number(reply.revision ?? 0);
		await this.#peer.receive(decode(String(reply.update)));
		this.#synced = true;
		if (loss) loss.reopenedAt = performance.now();
		for (let id of this.#outbox.keys()) this.#send(id);
		for (let release of this.#waiting.splice(0)) release();
	}

	#send(id: string): void {
		let update = this.#outbox.get(id);
		let socket = this.#socket;
		if (!update || !this.#epoch || !socket || socket.readyState !== WebSocket.OPEN) return;
		socket.send(JSON.stringify({
			kind: "plan:update",
			ts: Math.floor(Date.now() / 1000),
			rid: crypto.randomUUID().slice(0, 8),
			epoch: this.#epoch,
			id,
			update: encode(update),
		}));
		this.#sentAt.set(id, performance.now());
		if (!this.#firstSentAt.has(id)) this.#firstSentAt.set(id, performance.now());
	}

	#resend(): void {
		if (!this.#synced) return;
		for (let id of this.#outbox.keys()) {
			if (performance.now() - (this.#sentAt.get(id) ?? 0) > RESEND_MS) this.#send(id);
		}
	}

	#receive(raw: string): void {
		let frame: Frame;
		try {
			frame = JSON.parse(raw) as Frame;
		} catch {
			return;
		}
		if (frame.rid) {
			let waiting = this.#pending.get(frame.rid);
			if (waiting) {
				this.#pending.delete(frame.rid);
				waiting.resolve(frame);
				return;
			}
		}
		switch (frame.kind) {
			case "plan:ack": {
				let id = String(frame.id);
				if (this.#outbox.delete(id)) {
					this.acknowledged++;
					let first = this.#firstSentAt.get(id);
					if (first !== undefined) {
						let ms = performance.now() - first;
						this.ackMs.push(ms);
						this.acks.push({ at: performance.now(), ms });
					}
					this.#firstSentAt.delete(id);
					this.#sentAt.delete(id);
				}
				break;
			}
			case "plan:update":
				if (frame.epoch === this.#epoch) void this.#peer.receive(decode(String(frame.update)));
				break;
			case "plan:reset":
				if (frame.epoch !== this.#epoch) {
					this.resets.push({ at: performance.now(), reason: String(frame.reason) });
				}
				break;
			case "session:restarting":
				this.#announced = true;
				break;
			case "comment:sync":
				this.threads = frame.threads as typeof this.threads;
				break;
			case "comment:opened":
				this.threads.push(frame.thread as (typeof this.threads)[number]);
				break;
		}
	}
}
