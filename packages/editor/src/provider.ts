/**
 * A Yjs provider over the room's connection.
 *
 * Lexical's collaboration plugin expects a provider that owns a transport. The
 * room already has one, so this adapts it rather than opening a second socket:
 * one connection, one gate, one reconnect policy.
 *
 * The server is authoritative. This never bootstraps a document — it syncs to
 * what the server already has, which is what stops two clients opening an
 * empty plan from both seeding it.
 */

import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import type { Plan } from "@chopin/protocol";
import type { Provider } from "@lexical/yjs";
import type { Transport } from "./transport";

type Listener<T> = (value: T) => void;

type Events = {
	sync: boolean;
	status: { status: string };
	update: unknown;
	reload: Y.Doc;
};

/** Yjs updates are binary; the wire speaks JSON. */
function encode(value: Uint8Array): string {
	let binary = "";
	for (let byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function decode(value: string): Uint8Array {
	let binary = atob(value);
	let out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

export type PlanProviderOptions = {
	wire: Transport;
	doc: Y.Doc;
	/** Told when the server rotates the epoch and local state must be discarded. */
	onReset?: (reason: Plan.Reset["reason"]) => void;
	/**
	 * Authoritative snapshot of which prose each decision and comment names.
	 *
	 * The whole snapshot rather than one half: the two arrive together because
	 * they describe the same document at the same moment, and splitting them
	 * into two callbacks would let a consumer act on one while holding a stale
	 * copy of the other.
	 */
	onAnchors?: (snapshot: { widgets: Plan.WidgetAnchors[]; threads: Plan.ThreadAnchors[] }) => void;
};

/**
 * Bounds the unacknowledged outbox.
 *
 * Past either of these the connection has been down long enough that holding
 * every keystroke separately is wasteful. Yjs updates merge losslessly, so the
 * backlog is collapsed into one rather than trimmed: nothing is dropped, and
 * what is eventually replayed is the same document either way.
 */
const MAX_OUTBOX_BYTES = 2 * 1024 * 1024;
const MAX_OUTBOX_ITEMS = 1_000;

export class PlanProvider implements Provider {
	/**
	 * y-protocols' `Awareness` is structurally what Lexical wants, but its state
	 * is typed as an open record while Lexical narrows it to its own cursor
	 * shape. The runtime contract is identical.
	 */
	readonly awareness: Awareness & Provider["awareness"];

	readonly #wire: Transport;
	readonly #doc: Y.Doc;
	readonly #options: PlanProviderOptions;
	readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();
	readonly #offs: Array<() => void> = [];

	/** Updates sent but not yet acknowledged, replayed after a reconnect. */
	readonly #outbox = new Map<string, Uint8Array>();
	#outboxBytes = 0;

	#epoch: string | undefined;
	#synced = false;
	#connected = false;
	#counter = 0;
	#generation = 0;

	constructor(options: PlanProviderOptions) {
		this.#options = options;
		this.#wire = options.wire;
		this.#doc = options.doc;
		this.awareness = new Awareness(options.doc) as PlanProvider["awareness"];
	}

	get epoch(): string | undefined {
		return this.#epoch;
	}

	/** True while the backlog has grown past the point of holding it item by item. */
	get saturated(): boolean {
		return this.#outboxBytes >= MAX_OUTBOX_BYTES || this.#outbox.size >= MAX_OUTBOX_ITEMS;
	}

	/**
	 * Collapse the backlog into a single update.
	 *
	 * Only reachable while disconnected, since an acknowledgement removes an
	 * entry. The merged update carries a fresh id: the ones it replaces will
	 * never be acknowledged, because they were never received.
	 */
	#coalesce(): void {
		if (this.#outbox.size < 2) return;
		let merged = Y.mergeUpdates([...this.#outbox.values()]);
		this.#outbox.clear();
		this.#outbox.set(`merged-${this.#counter++}`, merged);
		this.#outboxBytes = merged.byteLength;
	}

	// -- provider surface ----------------------------------------------------

	on<K extends keyof Events>(type: K, cb: Listener<Events[K]>): void {
		let set = this.#listeners.get(type) ?? new Set();
		set.add(cb as Listener<never>);
		this.#listeners.set(type, set);
	}

	off<K extends keyof Events>(type: K, cb: Listener<Events[K]>): void {
		this.#listeners.get(type)?.delete(cb as Listener<never>);
	}

	#emit<K extends keyof Events>(type: K, value: Events[K]): void {
		for (let listener of this.#listeners.get(type) ?? []) {
			(listener as Listener<Events[K]>)(value);
		}
	}

	async connect(): Promise<void> {
		if (this.#connected) return;
		this.#connected = true;
		let generation = ++this.#generation;

		// Subscribe before opening: an update published between the reply being
		// built and this handler being attached would otherwise be lost.
		this.#offs.push(
			this.#wire.on<Plan.Update>("plan:update", event => this.#remote(event)),
			this.#wire.on<Plan.Ack>("plan:ack", event => this.#settle(event.id)),
			this.#wire.on<Plan.Awareness>("plan:awareness", event => this.#presence(event)),
			this.#wire.on<Plan.Reset>("plan:reset", event => this.#reset(event)),
			this.#wire.on<Plan.Anchors>("plan:anchors", event => {
				if (event.epoch === this.#epoch) {
					this.#options.onAnchors?.({ widgets: event.widgets, threads: event.threads });
				}
			}),
		);

		this.#doc.on("update", this.#local);
		this.awareness.on("update", this.#announce);

		await this.#open(generation);
	}

	disconnect(): void {
		this.#connected = false;
		this.#generation++;
		this.#synced = false;

		for (let off of this.#offs) off();
		this.#offs.length = 0;

		this.#doc.off("update", this.#local);
		this.awareness.off("update", this.#announce);
		this.awareness.destroy();

		this.#wire.send("plan:close", {});
		this.#emit("status", { status: "disconnected" });
		this.#emit("sync", false);
	}

	// -- synchronisation -----------------------------------------------------

	/**
	 * Join the document.
	 *
	 * Resuming the same epoch sends a state vector so the server replies with
	 * only the difference; a rotated epoch means local state is meaningless and
	 * the whole document is fetched instead.
	 */
	async #open(generation: number): Promise<void> {
		let resume = this.#epoch
			? { epoch: this.#epoch, vector: encode(Y.encodeStateVector(this.#doc)) }
			: {};

		let reply = await this.#wire.ask<Plan.Open.Reply>("plan:open", { ...resume });
		if (!this.#connected || generation !== this.#generation) return;

		let rotated = this.#epoch !== undefined && this.#epoch !== reply.epoch;
		this.#epoch = reply.epoch;

		// Server state never originates locally, so it must not be echoed back.
		Y.applyUpdate(this.#doc, decode(reply.update), this);
		this.#options.onAnchors?.({ widgets: reply.anchors, threads: reply.threads });

		if (reply.awareness) {
			applyAwarenessUpdate(this.awareness, decode(reply.awareness), this);
		}

		if (rotated) {
			this.#outbox.clear();
			this.#outboxBytes = 0;
		} else {
			this.#replay();
		}

		this.#synced = true;
		this.#emit("status", { status: "connected" });
		this.#emit("sync", true);
	}

	/**
	 * Resend updates whose acknowledgement never arrived.
	 *
	 * Yjs updates are idempotent, so a duplicate is harmless — losing one is
	 * not, which is why the outbox survives a reconnect on the same epoch.
	 */
	#replay(): void {
		for (let [id, update] of this.#outbox) this.#send(id, update);
	}

	#local = (update: Uint8Array, origin: unknown): void => {
		// Anything the server or the sync layer applied is already shared.
		if (origin === this || !this.#connected) return;

		let id = `${Date.now().toString(36)}-${this.#counter++}`;
		this.#outbox.set(id, update);
		this.#outboxBytes += update.byteLength;
		if (this.saturated) this.#coalesce();

		this.#send(id, update);
	};

	/**
	 * Send one update.
	 *
	 * Fire-and-forget rather than a correlated request: acknowledgements arrive
	 * as `plan:ack` and are matched by `id`, so a keystroke does not cost a
	 * pending promise, and an update whose ack is lost simply stays in the
	 * outbox until the next open replays it.
	 */
	#send(id: string, update: Uint8Array): void {
		if (!this.#epoch) return;
		this.#wire.send("plan:update", { epoch: this.#epoch, id, update: encode(update) });
	}

	#settle(id: string): void {
		let update = this.#outbox.get(id);
		if (!update) return;
		this.#outbox.delete(id);
		this.#outboxBytes -= update.byteLength;
	}

	#remote(event: Plan.Update): void {
		if (event.epoch !== this.#epoch) return;
		Y.applyUpdate(this.#doc, decode(event.update), this);
	}

	// -- presence ------------------------------------------------------------

	#announce = (
		{ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	): void => {
		if (origin === this || !this.#connected || !this.#epoch) return;

		let changed = [...added, ...updated, ...removed];
		if (changed.length === 0) return;

		this.#wire.send("plan:awareness", {
			epoch: this.#epoch,
			update: encode(encodeAwarenessUpdate(this.awareness, changed)),
		});
	};

	#presence(event: Plan.Awareness): void {
		if (event.epoch !== this.#epoch) return;
		applyAwarenessUpdate(this.awareness, decode(event.update), this);
	}

	// -- epoch rotation ------------------------------------------------------

	/**
	 * The server replaced the document.
	 *
	 * Local state describes a history that no longer exists, so it is discarded
	 * rather than merged. Undo and cursors are lost by design — this is the
	 * boundary where continuity ends.
	 */
	#reset(event: Plan.Reset): void {
		if (event.epoch === this.#epoch) return;

		this.#outbox.clear();
		this.#generation++;
		this.#outboxBytes = 0;
		this.#epoch = undefined;
		this.#synced = false;

		this.#emit("sync", false);
		this.#options.onReset?.(event.reason);
	}

	get synced(): boolean {
		return this.#synced;
	}
}
