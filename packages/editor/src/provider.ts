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
	status: { status: string; message?: string };
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
	/**
	 * Told when the server rotates the epoch and local state must be discarded.
	 *
	 * `lost` is true when edits the server never acknowledged went with it, so
	 * the person can be told rather than finding out later.
	 */
	onReset?: (reason: Plan.Reset["reason"], lost: boolean) => void;
	/**
	 * Authoritative snapshot of which prose each decision and comment names.
	 *
	 * The whole snapshot: these relationships arrive together because
	 * they describe the same document at the same moment, and splitting them
	 * into separate callbacks would let a consumer act on one while holding a
	 * stale copy of another.
	 */
	onAnchors?: (
		snapshot: {
			widgets: Plan.WidgetAnchors[];
			threads: Plan.ThreadAnchors[];
			prose: Plan.ProseAnchors[];
		},
	) => void;
	/**
	 * What the agent just did, to be marked in the prose.
	 *
	 * Unlike the anchors, this is not part of opening a document: it says what
	 * changed a moment ago, which is only true for a moment. Somebody arriving
	 * afterwards is reading the plan, not watching it being written.
	 */
	onChanges?: (changes: Plan.Change[]) => void;
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

/**
 * Pacing for outgoing updates.
 *
 * The server takes at most 200 updates a second from one socket and drops the
 * rest without replying. Typing faster than that (a script, a held key with a
 * fast repeat) lost the excess, and Yjs then held back every later update from
 * this client until the missing one arrived, so the rest of the session never
 * reached anyone. Updates made within one interval go out merged, which keeps
 * this client well under the limit, and anything still unacknowledged after a
 * while is sent again in case it was dropped anyway.
 */
const SEND_MS = 10;
/**
 * Resends back off from this, doubling up to `MAX_RESEND_MS`, so a server that
 * is slow to commit is not also asked to take every backlog again.
 */
const RESEND_MS = 2_000;
const MAX_RESEND_MS = 30_000;
/**
 * An update sent this many times without an acknowledgement is left for the
 * next open to replay. Something other than a dropped frame is refusing it.
 */
const MAX_SENDS = 5;
/** Merged updates stay far below the server's per-update limit. */
const MERGE_BYTES = 64 * 1024;

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
	/** Outbox entries waiting for the current send interval to end. */
	readonly #unsent = new Set<string>();
	/** Outbox entries already outstanding when the resend timer last fired. */
	#overdue = new Set<string>();
	/** How often each outbox entry has been sent since the last open. */
	readonly #sends = new Map<string, number>();
	#resendDelay = RESEND_MS;
	#pacing: ReturnType<typeof setTimeout> | undefined;
	#resending: ReturnType<typeof setTimeout> | undefined;

	#epoch: string | undefined;
	#synced = false;
	#connected = false;
	/** An open is in flight, so a second `resume` would ask for it twice. */
	#opening = false;
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
		this.#merge([...this.#outbox.keys()]);
	}

	/**
	 * Replace outbox entries with as few merged ones as stay under
	 * `MERGE_BYTES`, and return the ids that now hold them.
	 *
	 * A merged entry carries a fresh id: acknowledgements for the ones it
	 * replaces may still arrive and are ignored, and the merged one is only
	 * settled by its own.
	 */
	#merge(ids: string[]): string[] {
		let groups: string[][] = [];
		let size = 0;
		for (let id of ids) {
			let bytes = this.#outbox.get(id)?.byteLength;
			if (bytes === undefined) continue;
			let group = groups.at(-1);
			if (!group || size + bytes > MERGE_BYTES) {
				groups.push([id]);
				size = bytes;
			} else {
				group.push(id);
				size += bytes;
			}
		}

		return groups.map(group => {
			if (group.length === 1) return group[0]!;
			let merged = Y.mergeUpdates(group.map(id => this.#outbox.get(id)!));
			let id = `merged-${this.#counter++}`;
			let unsent = false;
			let sends = 0;
			for (let part of group) {
				this.#outboxBytes -= this.#outbox.get(part)!.byteLength;
				this.#outbox.delete(part);
				if (this.#unsent.delete(part)) unsent = true;
				this.#overdue.delete(part);
				sends = Math.max(sends, this.#sends.get(part) ?? 0);
				this.#sends.delete(part);
			}
			this.#outbox.set(id, merged);
			this.#outboxBytes += merged.byteLength;
			if (unsent) this.#unsent.add(id);
			if (sends > 0) this.#sends.set(id, sends);
			return id;
		});
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

	/**
	 * Open the document, or bring it back up to date.
	 *
	 * Safe to call whenever the transport says it can carry a request: on the
	 * first connection, and again after every reconnect.
	 *
	 * The provider used to open exactly once, when the editor mounted, and a
	 * transport comes up on its own schedule — so if the socket had not
	 * finished its handshake by then the plan never opened at all, and nothing
	 * tried again. The same gap swallowed a reconnect: `#open` is the only
	 * thing that asks for the updates missed while the connection was down and
	 * the only thing that replays the outbox, so without it the editor came
	 * back unlocked and quietly short of everybody else's edits.
	 *
	 * `#open` handles both cases already. It sends the epoch and state vector,
	 * so a resume fetches only the difference rather than the whole document.
	 */
	async resume(): Promise<void> {
		// Not attached yet, already opening, or the transport cannot carry it —
		// in the last case it will say when it can, and this runs again.
		if (!this.#connected || this.#opening) return;
		if (this.#wire.connected === false) return;

		this.#opening = true;
		try {
			await this.#open(this.#generation);
		} finally {
			this.#opening = false;
		}
	}

	async connect(): Promise<void> {
		if (this.#connected) return;
		this.#connected = true;
		this.#generation++;

		// Subscribe before opening: an update published between the reply being
		// built and this handler being attached would otherwise be lost.
		this.#offs.push(
			this.#wire.on<Plan.Update>("plan:update", event => this.#remote(event)),
			this.#wire.on<Plan.Ack>("plan:ack", event => this.#settle(event.id)),
			this.#wire.on<Plan.Awareness>("plan:awareness", event => this.#presence(event)),
			this.#wire.on<Plan.Reset>("plan:reset", event => this.#reset(event)),
			// Refused outright rather than dropped: repeating it changes nothing.
			this.#wire.on<{ message?: string }>("session:error", event => {
				if (event.message === "implementation is active") this.#park();
			}),
			this.#wire.on<Plan.Changes>("plan:changes", event => {
				if (event.epoch === this.#epoch) this.#options.onChanges?.(event.changes);
			}),
			this.#wire.on<Plan.Anchors>("plan:anchors", event => {
				if (event.epoch === this.#epoch) {
					this.#anchors({
						widgets: event.widgets,
						threads: event.threads,
						prose: event.prose ?? [],
					});
				}
			}),
		);

		this.#doc.on("update", this.#local);
		this.awareness.on("update", this.#announce);

		await this.resume();
	}

	/**
	 * Say the document could not be opened.
	 *
	 * Called by whoever started the connection, because it is the only place
	 * the rejection can be seen: `connect` is fired and forgotten, so a throw
	 * on the way in otherwise leaves the editor locked and the chrome claiming
	 * it is still loading.
	 */
	fail(message: string): void {
		this.#emit("status", { status: "failed", message });
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
		this.#stopTimers();

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

		/*
		 * The epoch rotated while this client was away, so it never heard the
		 * reset. Its document and outbox describe a history that no longer
		 * exists: merging the new state into it keeps edits nobody else has,
		 * and every later edit is acknowledged but never applies, because it
		 * builds on them. Rebuild from the server instead, as a reset would.
		 */
		if (this.#epoch !== undefined && this.#epoch !== reply.epoch) {
			this.#discard("replaced");
			return;
		}
		this.#epoch = reply.epoch;

		// Server state never originates locally, so it must not be echoed back.
		Y.applyUpdate(this.#doc, decode(reply.update), this);

		if (reply.awareness) {
			applyAwarenessUpdate(this.awareness, decode(reply.awareness), this);
		}

		this.#replay();

		this.#synced = true;
		this.#emit("status", { status: "connected" });
		this.#emit("sync", true);

		// After the document is open, never before it.
		//
		// Anchors decorate the prose; they are not a precondition for having
		// it. Resolving them here used to sit between applying the update and
		// declaring the document synced, so anything that threw while working
		// out where a decision pointed skipped the emit — and the editor stayed
		// locked for the rest of the session, with the rejection swallowed by
		// the `void connect()` that started it.
		this.#anchors({ widgets: reply.anchors, threads: reply.threads, prose: reply.prose ?? [] });
	}

	/**
	 * Hand the relationship snapshot on, whatever it does with it.
	 *
	 * Guarded because the alternative is a highlight failing to paint and
	 * taking the document with it. A reader losing an outline is a nuisance; a
	 * room that cannot be edited is not.
	 */
	#anchors(snapshot: {
		widgets: Plan.WidgetAnchors[];
		threads: Plan.ThreadAnchors[];
		prose: Plan.ProseAnchors[];
	}): void {
		try {
			this.#options.onAnchors?.(snapshot);
		} catch (err) {
			console.error("[plan] could not resolve where decisions point:", err);
		}
	}

	/**
	 * Resend updates whose acknowledgement never arrived.
	 *
	 * Yjs updates are idempotent, so a duplicate is harmless — losing one is
	 * not, which is why the outbox survives a reconnect on the same epoch.
	 * Merged first, so a long backlog does not arrive faster than the server
	 * accepts it.
	 */
	#replay(): void {
		this.#unsent.clear();
		this.#sends.clear();
		this.#resendDelay = RESEND_MS;
		for (let id of this.#merge([...this.#outbox.keys()])) this.#send(id);
	}

	#local = (update: Uint8Array, origin: unknown): void => {
		// Anything the server or the sync layer applied is already shared.
		if (origin === this || !this.#connected) return;

		let id = `${Date.now().toString(36)}-${this.#counter++}`;
		this.#outbox.set(id, update);
		this.#outboxBytes += update.byteLength;
		this.#unsent.add(id);
		if (this.saturated) this.#coalesce();

		if (!this.#pacing) this.#flush();
	};

	/** Send what this interval produced, and hold anything newer until it ends. */
	#flush(): void {
		if (!this.#epoch || this.#unsent.size === 0) return;
		let ids = this.#merge([...this.#unsent]);
		this.#unsent.clear();
		for (let id of ids) this.#send(id);
		this.#pacing = setTimeout(() => {
			this.#pacing = undefined;
			this.#flush();
		}, SEND_MS);
	}

	/**
	 * Send again whatever has gone a whole interval without an acknowledgement.
	 *
	 * Yjs updates are idempotent, so resending one that was merely slow costs
	 * a duplicate; not resending one that was dropped costs everything after it.
	 */
	#resend(): void {
		this.#resending = undefined;
		if (!this.#connected || !this.#synced || !this.#epoch) {
			// The next open replays the whole outbox.
			this.#overdue.clear();
			return;
		}
		let overdue = [...this.#outbox.keys()].filter(id =>
			this.#overdue.has(id) && !this.#unsent.has(id) && (this.#sends.get(id) ?? 0) < MAX_SENDS
		);
		if (overdue.length > 0) {
			this.#resendDelay = Math.min(this.#resendDelay * 2, MAX_RESEND_MS);
			for (let id of this.#merge(overdue)) this.#send(id);
		}
		this.#overdue = new Set(this.#outbox.keys());
		let waiting = [...this.#outbox.keys()].some(id => (this.#sends.get(id) ?? 0) < MAX_SENDS);
		if (waiting) this.#armResend();
	}

	#armResend(): void {
		this.#resending ??= setTimeout(() => this.#resend(), this.#resendDelay);
	}

	/** Stop resending what is outstanding now. The next open still replays it. */
	#park(): void {
		for (let id of this.#outbox.keys()) {
			if (!this.#unsent.has(id)) this.#sends.set(id, MAX_SENDS);
		}
	}

	#stopTimers(): void {
		clearTimeout(this.#pacing);
		clearTimeout(this.#resending);
		this.#pacing = undefined;
		this.#resending = undefined;
		this.#unsent.clear();
		this.#overdue.clear();
		this.#sends.clear();
		this.#resendDelay = RESEND_MS;
	}

	/**
	 * Send one update.
	 *
	 * Fire-and-forget rather than a correlated request: acknowledgements arrive
	 * as `plan:ack` and are matched by `id`, so a keystroke does not cost a
	 * pending promise, and an update whose ack never arrives stays in the
	 * outbox until `#resend` or the next open sends it again.
	 */
	#send(id: string): void {
		let update = this.#outbox.get(id);
		if (!this.#epoch || !update) return;
		this.#wire.send("plan:update", { epoch: this.#epoch, id, update: encode(update) });
		this.#sends.set(id, (this.#sends.get(id) ?? 0) + 1);
		this.#armResend();
	}

	#settle(id: string): void {
		let update = this.#outbox.get(id);
		if (!update) return;
		this.#outbox.delete(id);
		this.#outboxBytes -= update.byteLength;
		this.#overdue.delete(id);
		this.#sends.delete(id);
		// The server is accepting again, so the next resend need not wait long.
		this.#resendDelay = RESEND_MS;
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
		// The same epoch is the server refusing an oversized update while
		// keeping the document. Sending it again would be refused again.
		if (event.epoch === this.#epoch) return this.#park();
		this.#discard(event.reason);
	}

	#discard(reason: Plan.Reset["reason"]): void {
		let lost = this.#outbox.size > 0;
		this.#outbox.clear();
		this.#stopTimers();
		this.#generation++;
		this.#outboxBytes = 0;
		this.#epoch = undefined;
		this.#synced = false;

		this.#emit("sync", false);
		this.#options.onReset?.(reason, lost);
	}

	get synced(): boolean {
		return this.#synced;
	}
}
