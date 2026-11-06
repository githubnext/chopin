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

import { BUILD_PARAM, REFUSAL_HEADER } from "@chopin/protocol/restart";

import { activeActor } from "./active-actor";
import {
	lossOf,
	quietLeft,
	refusalOf,
	restartDelay,
	restartRetryDelay,
	runningBuild,
} from "./wire-loss";

import type { Session } from "@chopin/protocol";

export type Status =
	| "connecting"
	| "connected"
	| "reconnecting"
	| "denied"
	| "deleted"
	| "closed";

export type Unsubscribe = () => void;

/** A request the server refused; `code` marks a refusal to present in full. */
export class WireRefusal extends Error {
	readonly code: Session.Failure["code"];

	constructor(message: string, code?: Session.Failure["code"]) {
		super(message);
		this.name = "WireRefusal";
		this.code = code;
	}
}

/**
 * A request that was waiting for its answer when its connection went. `restarting` says the server
 * closed it because it is restarting, which ends within moments: a caller whose request can be made
 * again safely may keep its work and do so, without saying anything.
 */
export class WireLost extends Error {
	readonly restarting: boolean;

	constructor(message: string, restarting = false) {
		super(message);
		this.name = "WireLost";
		this.restarting = restarting;
	}
}

type Frame = { kind: string; ts: number; rid?: string; sender?: string };

type Listener = (frame: never) => void;

type Pending = {
	resolve: (frame: never) => void;
	reject: (error: Error) => void;
};

type WireTarget = { channelId: string } | { sidebar: true };

/** A connection that was lost and is being re-established, and how many attempts have failed. */
export type Outage = { failures: number };

export type WireOptions = WireTarget & {
	onStatus?: (status: Status, reason?: string) => void;
	/**
	 * Told when an outage begins, each time an attempt in it fails, and, with `undefined`, when the
	 * connection opens again. Automatic attempts and a person's both count, and neither a manual
	 * reconnect nor the network coming back resets the count: only a connection that opens does.
	 * A loss the server announced as a restart (close code 1012) raises none for `RESTART_QUIET_MS`,
	 * and the attempts that fail meanwhile are not counted: a restart that is over by then is never
	 * reported, and one that is not is reported then, as any other loss. A refusal ends the quiet at
	 * once and raises none: the server is not coming back for this connection.
	 */
	onOutage?: (outage: Outage | undefined) => void;
	onAuthenticationRequired?: () => void;
	onDeleted?: () => void;
};

type Refusal = { reason: string; authentication: boolean };

const BASE_DELAY = 500;
const MAX_DELAY = 15_000;
/** The least time between attempts that a wake may start. */
const WAKE_GAP = 1000;
/**
 * When, after a loss, one attempt is guaranteed to start.
 *
 * Just inside the 1.5 s grace the page waits out before saying anything
 * (`CONNECTION_GRACE` in the editor), so a short outage reconnects before it
 * is shown rather than flashing a notice, and a lock, for a moment past it.
 */
const RESCUE_AT = 1200;
/**
 * The longest the probe that asks why a connection was lost may take. A probe that never answers
 * (a network that drops packets rather than refusing them) must not stall the retries, nor keep
 * the page from saying it is offline.
 */
const PROBE_TIMEOUT = 4000;

function endpoint(options: WireOptions): string {
	let url = new URL("sidebar" in options ? "/ws/sidebar" : "/ws", location.href);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	if ("channelId" in options) {
		url.searchParams.set("channel", options.channelId);
		let actor = activeActor();
		if (actor) url.searchParams.set("actor", actor.id);
	}
	let build = runningBuild(globalThis.document);
	if (build) url.searchParams.set(BUILD_PARAM, build);
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
	/** Attempts that ended without opening since the last connection did. */
	#failures = 0;
	#attemptedAt = 0;
	/** When the current outage began, or undefined while connected. */
	#lostAt: number | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** Whether the probe after a loss is still awaiting its answer. */
	#probing = false;
	/** Whether `onOutage` has been told of this outage, so that it is told when it ends. */
	#outageTold = false;
	/** Raises the outage of a restart that outlasts its quiet period. */
	#quietTimer: ReturnType<typeof setTimeout> | undefined;
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
	/** Whether the current outage began with the server saying it is restarting. */
	#restarting = false;
	/** Whether the open socket was told by `session:restarting` that its close is a restart. */
	#announced = false;
	#disposed = false;
	#terminal = false;
	#connectionGeneration = 0;

	constructor(options: WireOptions) {
		this.#options = options;
		addEventListener("online", this.#wake);
		addEventListener("focus", this.#wake);
		globalThis.document?.addEventListener("visibilitychange", this.#wake);
		this.#connect();
	}

	/**
	 * Skip the rest of the backoff when the network or the person comes back.
	 *
	 * The timer alone can sit out most of its 15 s cap after the network has
	 * already returned, with the page still saying it is offline. Only a wire
	 * waiting on that timer, or on the probe that precedes it, is woken; an
	 * attempt already in flight is left to finish.
	 *
	 * Focus and visibility say only that the person is back, not the network,
	 * and they can fire in bursts. So they never wake the wire sooner than
	 * `WAKE_GAP` after the last attempt, and only `online` forgets the
	 * backoff: a deploy outage must not turn every tab switch on every client
	 * into a fresh run of fast retries.
	 */
	#wake = (event: Event) => {
		if (this.#disposed || this.#terminal) return;
		if (this.#timer === undefined && !this.#probing) return;
		if (globalThis.document?.visibilityState === "hidden") return;
		let online = event.type === "online";
		if (!online && Date.now() - this.#attemptedAt < WAKE_GAP) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (online) this.#attempts = 0;
		this.#connect();
	};

	#unlisten(): void {
		removeEventListener("online", this.#wake);
		removeEventListener("focus", this.#wake);
		globalThis.document?.removeEventListener("visibilitychange", this.#wake);
	}

	get status(): Status {
		return this.#status ?? "connecting";
	}

	/**
	 * Whether the connection was lost because the server is restarting, until it is back or refuses it.
	 *
	 * A restart is expected to end on its own within moments, so what is shown about it may
	 * wait longer than for any other loss. What has to act on the connection must not: read
	 * `status` and `connected` for that.
	 */
	get restarting(): boolean {
		return this.#restarting;
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

	/**
	 * Try again now, at a person's request.
	 *
	 * The backoff starts over: someone who asks to reconnect is saying the
	 * network may be back, and after a few failed asks the next automatic
	 * attempt must not still be waiting out the cap.
	 */
	reconnect(): void {
		if (this.#disposed || this.#terminal) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#attempts = 0;
		let previous = this.#socket;
		this.#socket = undefined;
		this.#abandon("connection restarted");
		previous?.close();
		this.#connect();
	}

	#set(status: Status, reason?: string): void {
		if (this.#status === status) return;
		this.#status = status;
		this.#options.onStatus?.(status, reason);
	}

	#connect(): void {
		if (this.#disposed || this.#terminal) return;
		this.#connectionGeneration++;
		// A new attempt supersedes any probe still awaiting its answer.
		this.#probing = false;
		this.#attemptedAt = Date.now();
		this.#set(this.#everConnected ? "reconnecting" : "connecting");

		let socket = new WebSocket(endpoint(this.#options));
		this.#socket = socket;
		this.#announced = false;

		let opened = false;
		socket.addEventListener("open", () => {
			if (this.#socket !== socket) return;
			opened = true;
			let recovered = this.#outageTold;
			this.#outageTold = false;
			this.#everConnected = true;
			this.#attempts = 0;
			this.#failures = 0;
			this.#lostAt = undefined;
			this.#restarting = false;
			clearTimeout(this.#quietTimer);
			this.#quietTimer = undefined;
			if (recovered) this.#options.onOutage?.(undefined);
			this.#set("connected");
		});

		socket.addEventListener("message", event => {
			if (this.#socket !== socket) return;
			if (typeof event.data !== "string") return;
			this.#receive(event.data);
		});

		socket.addEventListener("close", event => {
			// A socket superseded by a reconnect must not drive status or retries.
			if (this.#socket !== socket) return;
			this.#socket = undefined;
			let loss = lossOf(event.code, this.#announced);
			this.#announced = false;
			if (loss === "deleted") {
				this.#deleted();
				return;
			}
			this.#lostAt ??= Date.now();
			// A restart is expected to end on its own within moments: until its quiet has passed, an
			// attempt that fails is not counted and no outage is raised for it (`#quietLeft`).
			if (loss === "restart") this.#restarting = true;
			if (!opened && this.#quietLeft() <= 0) this.#failures++;
			this.#raiseOutage();
			this.#abandon("connection lost", loss === "restart");
			// Said now, not once the probe has answered: until then nothing else says it is lost.
			this.#set("reconnecting");
			if (loss === "restart") this.#restart();
			else void this.#retry();
		});
	}

	#quietLeft(): number {
		return quietLeft(this.#restarting, this.#lostAt, Date.now());
	}

	/**
	 * Tell `onOutage` the connection is lost, with how many attempts have failed.
	 *
	 * Not while a restart is quiet: the server said it is coming back, and nothing is to show for
	 * that yet, which is what the outage is for. If the restart outlasts its quiet period the
	 * outage is raised then, whether or not an attempt has failed by that time, and goes on as
	 * for any other loss.
	 */
	#raiseOutage(): void {
		let quiet = this.#quietLeft();
		if (quiet <= 0) {
			this.#outageTold = true;
			this.#options.onOutage?.({ failures: this.#failures });
			return;
		}
		if (this.#quietTimer !== undefined) return;
		this.#quietTimer = setTimeout(() => {
			this.#quietTimer = undefined;
			if (this.#lostAt === undefined || this.#disposed || this.#terminal) return;
			this.#outageTold = true;
			this.#options.onOutage?.({ failures: this.#failures });
		}, quiet);
	}

	/**
	 * Come back after the server said it is restarting.
	 *
	 * Not asked first whether the door is open: it is about to be shut, and the first attempt
	 * is what finds out. It waits a jittered moment so that every tab of the server does not
	 * return in the same instant. An attempt that fails is followed by another soon while the
	 * restart is quiet, and after that the ordinary ladder goes on from where it was.
	 */
	#restart(): void {
		this.#attempts++;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#connect();
		}, restartDelay(Math.random()));
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
				signal: AbortSignal.timeout(PROBE_TIMEOUT),
			});
			let refusal = refusalOf(response.status, response.headers.get(REFUSAL_HEADER) === "1");
			if (refusal) {
				return { reason: await response.text(), authentication: refusal === "authentication" };
			}
		} catch {
			// Unreachable, or too slow to say, rather than refused; the retry loop is the right answer.
		}
		return undefined;
	}

	async #retry(): Promise<void> {
		if (this.#disposed || this.#terminal) return;
		let generation = this.#connectionGeneration;

		this.#probing = true;
		let refusal = await this.#refusal();
		if (this.#disposed || this.#terminal || generation !== this.#connectionGeneration) return;
		this.#probing = false;
		if (refusal) {
			// A refusal says the server is not about to return for this connection: the restart's
			// quiet ends here, with no outage raised for it.
			this.#restarting = false;
			clearTimeout(this.#quietTimer);
			this.#quietTimer = undefined;
			if (refusal.authentication) this.#options.onAuthenticationRequired?.();
			return this.#set("denied", refusal.reason);
		}

		// While a restart is quiet the next attempt is never far off, so that a server that is
		// back is found at once, and those attempts do not count towards the backoff that follows.
		let quiet = this.#quietLeft() > 0;
		let delay = quiet
			? restartRetryDelay(Math.random())
			: Math.min(BASE_DELAY * 2 ** this.#attempts, MAX_DELAY) * (0.5 + Math.random());
		if (!quiet && this.#lostAt !== undefined) {
			let rescue = this.#lostAt + RESCUE_AT - Date.now();
			if (rescue > 0) delay = Math.min(delay, rescue);
		}
		if (!quiet) this.#attempts++;
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.#connect();
		}, delay);
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
					let failure = frame as Partial<Session.Failure>;
					waiting.reject(new WireRefusal(String(failure.message), failure.code));
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
		if (frame.kind === "session:restarting") this.#announced = true;
	}

	#deleted(): void {
		if (this.#disposed || this.#terminal) return;
		this.#terminal = true;
		this.#unlisten();
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		clearTimeout(this.#quietTimer);
		this.#quietTimer = undefined;
		let socket = this.#socket;
		this.#socket = undefined;
		this.#abandon("document deleted");
		this.#set("deleted", "document deleted");
		socket?.close();
		this.#options.onDeleted?.();
	}

	/** Reject everything still waiting; a reply cannot survive its connection. */
	#abandon(reason: string, restarting = false): void {
		for (let waiting of this.#pending.values()) waiting.reject(new WireLost(reason, restarting));
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
		this.#unlisten();
		if (this.#timer) clearTimeout(this.#timer);
		clearTimeout(this.#quietTimer);
		this.#quietTimer = undefined;
		this.#abandon("disposed");
		this.#socket?.close();
		this.#socket = undefined;
		if (!this.#terminal) this.#set("closed");
	}
}
