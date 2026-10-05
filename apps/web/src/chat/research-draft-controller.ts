import * as Draft from "@chopin/draft";
import type { ConversationPlan } from "@chopin/protocol";
import type { Wire } from "../wire";

type Snapshot = {
	text: string;
	editing: boolean;
	syncing: boolean;
	closed: boolean;
	error?: string;
};
type Transport = Pick<Wire, "ask" | "send" | "connected">;

/** Lives at offer scope, independently of where its card sits in the transcript. */
export class ResearchDraftController {
	#offer: ConversationPlan.ResearchOffer;
	#wire?: Transport;
	#model?: Draft.Model;
	#sid?: number;
	#outbox: number[][] = [];
	#sending?: Promise<void>;
	#opening?: Promise<void>;
	#listeners = new Set<() => void>();
	#snapshot: Snapshot;
	#connection = 0;
	#connected = false;
	constructor(offer: ConversationPlan.ResearchOffer) {
		this.#offer = offer;
		this.#snapshot = {
			text: offer.brief,
			editing: false,
			syncing: false,
			closed: offer.status !== "offered",
		};
	}
	get = () => this.#snapshot;
	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};
	base = () => this.#model?.clone();
	#set(patch: Partial<Snapshot>) {
		this.#snapshot = { ...this.#snapshot, ...patch };
		for (let listener of this.#listeners) listener();
	}
	configure(
		wire: Transport | undefined,
		connected: boolean,
		offer: ConversationPlan.ResearchOffer,
	) {
		if (wire !== this.#wire || connected !== this.#connected) {
			this.#connection++;
			this.#sending = undefined;
			this.#opening = undefined;
		}
		this.#wire = wire;
		this.#connected = connected;
		this.receive(offer);
		if (connected && this.#snapshot.editing) {
			this.focus(true);
			this.#pump();
		}
	}
	receive(offer: ConversationPlan.ResearchOffer) {
		if (
			(offer.workflow?.revision ?? 0) < (this.#offer.workflow?.revision ?? 0)
			|| this.#offer.status !== "offered" && offer.status === "offered"
		) return;
		this.#offer = offer;
		if (offer.status !== "offered") {
			let lost = this.#outbox.length > 0;
			this.#outbox = [];
			this.#set({
				closed: true,
				syncing: false,
				editing: false,
				text: offer.brief,
				...(lost ? { error: "Research was closed before your last edits were accepted." } : {}),
			});
			return;
		}
		if (offer.workflow?.draft) {
			let model = Draft.restore(offer.workflow.draft).fork(this.#sid);
			this.#sid = model.clock.sid;
			for (let patch of this.#outbox) model = Draft.apply(model, patch);
			this.#model = model;
			this.#set({ text: Draft.read(model), syncing: this.#outbox.length > 0 });
		} else this.#set({ text: offer.brief });
	}
	begin = async () => {
		if (!this.#wire?.connected || !this.#connected) throw new Error("Reconnect to edit research.");
		if (this.#opening) return this.#opening;
		let connection = this.#connection;
		this.#set({ syncing: true, error: undefined });
		let task = this.#wire.ask<ConversationPlan.ResearchEdited>("conversation-plan:research-edit", {
			offerId: this.#offer.id,
			operation: { kind: "begin" },
		}).then(result => {
			if (connection !== this.#connection) return;
			this.receive(result.offer);
			if (!this.#snapshot.closed) {
				this.#set({ editing: true, syncing: false });
				this.focus(true);
			}
		}).catch(error => {
			this.#set({ syncing: false, error: "Could not open the shared research brief." });
			throw error;
		}).finally(() => {
			if (this.#opening === task) this.#opening = undefined;
		});
		this.#opening = task;
		return task;
	};
	change = (value: string, displayed = this.#model) => {
		if (!displayed || !this.#model || this.#snapshot.closed) return;
		try {
			let patch = Draft.change(displayed, value);
			if (!patch) return;
			let next = Draft.apply(this.#model, patch);
			this.#model = next;
			this.#outbox.push(patch);
			this.#set({ text: Draft.read(next), syncing: true, error: undefined });
			this.#pump();
		} catch (error) {
			this.#set({ error: error instanceof Error ? error.message : "Invalid brief edit" });
		}
	};
	#pump() {
		if (this.#sending || !this.#outbox.length || !this.#wire?.connected || !this.#connected) return;
		let connection = this.#connection;
		let wire = this.#wire;
		let task = (async () => {
			while (this.#outbox.length && connection === this.#connection && !this.#snapshot.closed) {
				let patch = this.#outbox[0]!;
				try {
					let result = await wire.ask<ConversationPlan.ResearchEdited>(
						"conversation-plan:research-edit",
						{ offerId: this.#offer.id, operation: { kind: "patch", patch } },
					);
					if (connection !== this.#connection) return;
					if (this.#outbox[0] === patch) this.#outbox.shift();
					this.receive(result.offer);
				} catch {
					if (connection === this.#connection) {
						this.#set({ error: "Research edits are waiting to sync." });
					}
					return;
				}
			}
		})().finally(() => {
			if (this.#sending === task) this.#sending = undefined;
		});
		this.#sending = task;
	}
	flush = async () => {
		await this.#opening;
		this.#pump();
		await this.#sending;
		if (!this.#wire?.connected || this.#outbox.length) {
			throw new Error("Research edits have not synchronized. Reconnect and try again.");
		}
	};
	focus(editing: boolean) {
		if (this.#wire?.connected) {
			this.#wire.send("conversation-plan:research-presence", { offerId: this.#offer.id, editing });
		}
	}
	end = () => {
		this.focus(false);
		this.#set({ editing: false });
	};
}
