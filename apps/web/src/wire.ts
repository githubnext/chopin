/**
 * The client end of the wire.
 *
 * Three verbs, because that is all anything needs: `on` to watch a kind, `send`
 * to say something, `ask` to say something and be answered. Replies correlate
 * by `rid`, so a request does not need its own reply kind and two requests of
 * the same kind cannot be confused for one another.
 *
 * The URL is derived from `location`, never configured. That is what makes the
 * same build work on localhost, over a LAN address, and through a tunnel.
 */

export type Status =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "denied"
	| "deleted"
	| "closed";

export type Unsubscribe = () => void;

type Frame = { kind: string; ts: number; rid?: string; sender?: string };

type Listener = (frame: never) => void;

type Pending = {
	resolve: (frame: never) => void;
	reject: (error: Error) => void;
};

export type WireOptions = {
	channelId: string;
	onStatus?: (status: Status, reason?: string) => void;
	onAuthenticationRequired?: () => void;
	onDeleted?: () => void;
};

type Refusal = { reason: string; authentication: boolean };

const BASE_DELAY = 500;
const MAX_DELAY = 15_000;

function endpoint(options: WireOptions): string {
	let url = new URL("/ws", location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("channel", options.channelId);
	return url.href;
}

function rid(): string {
	return crypto.randomUUID().slice(0, 8);
}

export class Wire {
	#options: WireOptions;
	#socket: WebSocket | undefined;
	#listeners = new Map<string, Set<Listener>>();
	#pending = new Map<string, Pending>();
	#attempts = 0;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Undefined until the first transition, so the first one always announces.
	 *
	 * Started at `"connecting"` this would swallow its own opening state, and a
	 * caller sharing one status across instances — React mounting, discarding
	 * and remounting is exactly this — would keep displaying the dead
	 * instance's last word until the new one happened to reach a different
	 * state. A socket that never opens then reports the previous socket's
	 * closure forever.
	 */
	#status: Status | undefined;
	#everConnected = false;
	#disposed = false;
	#terminal = false;

	constructor(options: WireOptions) {
		this.#options = options;
		this.#connect();
	}

	get status(): Status {
		return this.#status ?? "connecting";
	}

	/**
	 * Whether a request can be carried right now.
	 *
	 * Not the same as the reported status: `connected` is published from the
	 * socket's open event, and a caller may be asking before that has run.
	 * This reads the socket itself, which is what `ask` will do a moment later.
	 */
	get connected(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	#set(status: Status, reason?: string): void {
		if (this.#status === status) return;
		this.#status = status;
		this.#options.onStatus?.(status, reason);
	}

	#connect(): void {
		if (this.#disposed || this.#terminal) return;
		this.#set(this.#everConnected ? "reconnecting" : "connecting");

		let socket = new WebSocket(endpoint(this.#options));
		this.#socket = socket;

		socket.addEventListener("open", () => {
			this.#everConnected = true;
			this.#attempts = 0;
			this.#set("connected");
		});

		socket.addEventListener("message", event => {
			if (typeof event.data !== "string") return;
			this.#receive(event.data);
		});

		socket.addEventListener("close", event => {
			// A socket superseded by a reconnect must not drive status or retries.
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			if (event.code === 4404) {
				this.#deleted();
				return;
			}
			this.#abandon("connection lost");
			void this.#retry();
		});
	}

	/**
	 * Work out why a connection attempt was refused.
	 *
	 * A browser cannot see the status of a failed upgrade — a rejected access
	 * key and an unreachable server both surface as a bare close. The endpoint
	 * answers an ordinary request with the reason, so ask it once rather than
	 * retrying eight times against a door that will not open.
	 */
	async #refusal(): Promise<Refusal | undefined> {
		try {
			let response = await fetch(endpoint(this.#options).replace(/^ws/, "http"), {
				headers: { "x-chopin-socket-probe": "1" },
			});
			if (response.status >= 400 && response.status < 500) {
				return {
					reason: await response.text(),
					authentication: response.status === 401,
				};
			}
		} catch {
			// Unreachable rather than refused; the retry loop is the right answer.
		}
		return undefined;
	}

	async #retry(): Promise<void> {
		if (this.#disposed || this.#terminal) return;

		let refusal = await this.#refusal();
		if (this.#disposed || this.#terminal) return;
		if (refusal) {
			if (refusal.authentication) this.#options.onAuthenticationRequired?.();
			return this.#set("denied", refusal.reason);
		}

		let delay = Math.min(BASE_DELAY * 2 ** this.#attempts, MAX_DELAY) * (0.5 + Math.random());
		this.#attempts++;
		this.#set("reconnecting");
		this.#timer = setTimeout(() => this.#connect(), delay);
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
				if (frame.kind === "session:error") {
					waiting.reject(new Error(String((frame as { message?: string }).message)));
				} else {
					waiting.resolve(frame as never);
				}
			}
		}

		/*
		 * One listener at a time.
		 *
		 * Frames are fanned out in a loop, so without this the first handler to
		 * throw silences every handler registered after it for that kind — the
		 * same failure Lexical's update listeners have, and just as quiet. A
		 * broken sidecar must not stop the transcript from arriving.
		 */
		for (let listener of this.#listeners.get(frame.kind) ?? []) {
			try {
				listener(frame as never);
			} catch (err) {
				console.error(`[wire] ${frame.kind} listener failed:`, err);
			}
		}
		if (frame.kind === "session:deleted") this.#deleted();
	}

	#deleted(): void {
		if (this.#disposed || this.#terminal) return;
		this.#terminal = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		let socket = this.#socket;
		this.#socket = undefined;
		this.#abandon("document deleted");
		this.#set("deleted", "document deleted");
		socket?.close();
		this.#options.onDeleted?.();
	}

	/** Reject everything still waiting; a reply cannot survive its connection. */
	#abandon(reason: string): void {
		for (let waiting of this.#pending.values()) waiting.reject(new Error(reason));
		this.#pending.clear();
	}

	on<T>(kind: string, listener: (frame: T) => void): Unsubscribe {
		let set = this.#listeners.get(kind);
		if (!set) this.#listeners.set(kind, set = new Set());
		set.add(listener as Listener);
		return () => set.delete(listener as Listener);
	}

	send(kind: string, payload: Record<string, unknown> = {}): void {
		if (this.#socket?.readyState !== WebSocket.OPEN) return;
		this.#socket.send(JSON.stringify({
			...payload,
			kind,
			ts: Math.floor(Date.now() / 1000),
			rid: rid(),
		}));
	}

	ask<T>(kind: string, payload: Record<string, unknown> = {}): Promise<T> {
		if (this.#socket?.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("not connected"));
		}
		let id = rid();
		let task = Promise.withResolvers<T>();
		this.#pending.set(id, task as unknown as Pending);
		this.#socket.send(JSON.stringify({
			...payload,
			kind,
			ts: Math.floor(Date.now() / 1000),
			rid: id,
		}));
		return task.promise;
	}

	dispose(): void {
		this.#disposed = true;
		if (this.#timer) clearTimeout(this.#timer);
		this.#abandon("disposed");
		this.#socket?.close();
		this.#socket = undefined;
		if (!this.#terminal) this.#set("closed");
	}
}
