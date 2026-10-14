import { MAX_SOURCE_BYTES } from "@chopin/dialect/limits";
import type { DocumentDevelopment } from "@chopin/protocol";
import type { Wire } from "./wire";

type Summary = DocumentDevelopment.RecoverySummary;
type Snapshot = {
	items: Summary[];
	open: boolean;
	selected?: Summary;
	source?: string;
	loading: boolean;
	resolving?: "add" | "dismiss";
	error?: string;
};

/** Saved alternatives remain available even when automatic draft updates are disabled. */
export class DocumentRecoveryStore {
	#snapshot: Snapshot = { items: [], open: false, loading: false };
	#listeners = new Set<() => void>();
	#wire?: Wire;
	#request = 0;

	get = (): Snapshot => this.#snapshot;
	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	reset(): void {
		this.#request++;
		this.#set({ items: [], open: false, loading: false });
	}

	listen(wire: Wire): () => void {
		this.reset();
		this.#wire = wire;
		let off = wire.on<DocumentDevelopment.RecoveryState>(
			"document-development:recovery-state",
			state => {
				// Correlated replies belong to the guarded request that issued them.
				if (this.#wire === wire && !state.rid) this.#accept(state);
			},
		);
		return () => {
			off();
			if (this.#wire !== wire) return;
			this.#wire = undefined;
			this.reset();
		};
	}

	open = (): void => {
		if (this.#snapshot.items.length) this.#set({ ...this.#snapshot, open: true });
	};

	close = (): void => {
		this.#request++;
		this.#set({ items: this.#snapshot.items, open: false, loading: false });
	};

	back = (): void => {
		this.#request++;
		this.#set({ items: this.#snapshot.items, open: true, loading: false });
	};

	async read(summary: Summary): Promise<void> {
		let wire = this.#wire;
		if (!wire?.connected || !this.#has(summary)) return;
		let request = ++this.#request;
		this.#set({ items: this.#snapshot.items, open: true, selected: summary, loading: true });
		try {
			let reply = await wire.ask<DocumentDevelopment.RecoveryReadReply>(
				"document-development:recovery-read",
				{ id: summary.id, digest: summary.digest },
			);
			if (this.#wire !== wire || request !== this.#request || !this.#has(summary)) return;
			if (
				reply.item.id !== summary.id || reply.item.digest !== summary.digest
				|| typeof reply.item.source !== "string"
				|| new TextEncoder().encode(reply.item.source).byteLength > MAX_SOURCE_BYTES
			) throw new Error("These recovered edits have changed. Open the latest version.");
			this.#set({ ...this.#snapshot, loading: false, source: reply.item.source });
		} catch (error) {
			if (this.#wire !== wire || request !== this.#request) return;
			this.#set({ ...this.#snapshot, loading: false, error: this.#error(error) });
		}
	}

	async resolve(action: "add" | "dismiss"): Promise<void> {
		let wire = this.#wire;
		let selected = this.#snapshot.selected;
		if (
			!wire?.connected || !selected || this.#snapshot.source === undefined
			|| this.#snapshot.resolving || !this.#has(selected)
		) return;
		let request = ++this.#request;
		this.#set({ ...this.#snapshot, resolving: action, error: undefined });
		try {
			let state = await wire.ask<DocumentDevelopment.RecoveryState>(
				"document-development:recovery-resolve",
				{ id: selected.id, digest: selected.digest, action },
			);
			if (this.#wire !== wire || request !== this.#request) return;
			this.#accept(state);
			this.#set({
				items: this.#snapshot.items,
				open: this.#snapshot.items.length > 0,
				loading: false,
			});
		} catch (error) {
			if (this.#wire !== wire || request !== this.#request) return;
			this.#set({ ...this.#snapshot, resolving: undefined, error: this.#error(error) });
		}
	}

	#has(summary: Summary): boolean {
		return this.#snapshot.items.some(item =>
			item.id === summary.id && item.digest === summary.digest
		);
	}

	#accept(state: DocumentDevelopment.RecoveryState): void {
		if (
			!Array.isArray(state.items) || state.items.length > 48
			|| state.items.some(item =>
				typeof item.id !== "string" || !item.id || item.id.length > 200
				|| !/^sha256:[a-f0-9]{64}$/.test(item.digest)
				|| typeof item.preview !== "string" || item.preview.length > 1200
			)
		) return;
		let selected = this.#snapshot.selected;
		let current = selected
			&& state.items.some(item => item.id === selected.id && item.digest === selected.digest);
		if (selected && !current) {
			this.#request++;
			this.#set({
				items: state.items,
				open: this.#snapshot.open && state.items.length > 0,
				loading: false,
			});
		} else {
			this.#set({
				...this.#snapshot,
				items: state.items,
				open: this.#snapshot.open && state.items.length > 0,
			});
		}
	}

	#error(error: unknown): string {
		return error instanceof Error ? error.message : "Couldn't load these recovered edits.";
	}

	#set(snapshot: Snapshot): void {
		this.#snapshot = snapshot;
		for (let listener of this.#listeners) listener();
	}
}
