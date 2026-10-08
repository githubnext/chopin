import { Visual } from "@chopin/question";

import type { VisualDecision } from "@chopin/protocol";
import type { Transport } from "./transport";

type Edit = { key: string; patch: Partial<VisualDecision.Values> };
export type VisualDecisionSnapshot = {
	state?: VisualDecision.State;
	syncing: boolean;
	pending: number;
	saving: boolean;
	error?: string;
};

/** One acknowledged outbox for every mounted view of the same decision. */
export class VisualDecisionController {
	#snapshot: VisualDecisionSnapshot = { syncing: true, pending: 0, saving: false };
	#listeners = new Set<() => void>();
	#off?: () => void;
	#connected = false;
	#generation = 0;
	#queue: Edit[] = [];
	#sending = false;
	#blocked = false;
	#client = crypto.randomUUID();
	#sequence = 0;

	constructor(private wire: Transport | undefined, private id: string) {}

	getSnapshot = (): VisualDecisionSnapshot => this.#snapshot;

	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		if (!this.#off && this.wire) {
			let offChanged = this.wire.on<{ state: VisualDecision.State }>(
				"visual-decision:changed",
				frame => this.#accept(frame.state),
			);
			// Display connection flags can hide a short outage; every socket admission must reopen.
			let offHello = this.wire.on("session:hello", () => {
				this.configure(false);
				this.configure(true);
			});
			this.#off = () => {
				offChanged();
				offHello();
			};
		}
		return () => {
			this.#listeners.delete(listener);
			if (!this.#listeners.size) {
				this.#off?.();
				this.#off = undefined;
				this.configure(false);
			}
		};
	};

	configure(connected: boolean): void {
		connected = connected && !!this.wire && this.wire.connected !== false;
		if (this.#connected === connected) return;
		this.#connected = connected;
		this.#generation++;
		this.#sending = false;
		this.#set({ syncing: true, saving: false });
		if (connected) void this.#open();
	}

	change = (raw: Partial<VisualDecision.Values>): void => {
		if (!this.#editable()) return;
		let patch: Partial<VisualDecision.Values>;
		try {
			patch = Visual.patch(this.#snapshot.state!.definition, raw);
		} catch (error) {
			this.#set({ error: error instanceof Error ? error.message : "Check the control value." });
			return;
		}
		this.#queue.push({ key: `${this.#client}:${++this.#sequence}`, patch });
		this.#blocked = false;
		this.#set({ pending: this.#queue.length, error: undefined });
		void this.#flush();
	};

	reset = (): void => {
		let baseline = this.#snapshot.state?.definition.baseline;
		if (baseline) this.change(baseline);
	};

	retry = (): void => {
		if (!this.#connected) return;
		this.#blocked = false;
		this.#set({ error: undefined });
		if (this.#snapshot.syncing) void this.#open();
		else void this.#flush();
	};

	save = async (): Promise<void> => {
		let state = this.#snapshot.state;
		if (!state || !this.#editable() || this.#queue.length) return;
		let generation = this.#generation;
		this.#set({ saving: true, error: undefined });
		try {
			let result = await this.wire!.ask<VisualDecision.Result>("visual-decision:save", {
				id: this.id,
				revision: state.revision,
				definitionRevision: state.definition.definitionRevision,
			});
			if (generation !== this.#generation) return;
			if (result.state) this.#accept(result.state);
			if (!result.ok) {
				this.#set({
					error: result.reason === "stale"
						? "The draft changed. Review the latest values, then save again."
						: result.message ?? "This decision could not be saved. Try again.",
				});
			}
		} catch {
			if (generation === this.#generation) {
				this.#set({ error: "This decision could not be saved. Try again." });
			}
		} finally {
			if (generation === this.#generation) this.#set({ saving: false });
		}
	};

	#editable(): boolean {
		return this.#connected && !this.#snapshot.syncing && !this.#snapshot.saving
			&& !!this.#snapshot.state && !this.#snapshot.state.saved;
	}

	async #open(): Promise<void> {
		let generation = this.#generation;
		try {
			let result = await this.wire!.ask<VisualDecision.Result>("visual-decision:open", {
				id: this.id,
			});
			if (generation !== this.#generation) return;
			if (!result.ok) throw new Error("Could not open decision");
			this.#accept(result.state);
			this.#blocked = false;
			this.#set({ syncing: false, error: undefined });
			void this.#flush();
		} catch {
			if (generation === this.#generation) {
				this.#set({ error: "The shared draft could not be loaded. Try again." });
			}
		}
	}

	async #flush(): Promise<void> {
		if (!this.#editable() || this.#sending || this.#blocked) return;
		let edit = this.#queue[0];
		if (!edit) return;
		this.#sending = true;
		let generation = this.#generation;
		try {
			let result = await this.wire!.ask<VisualDecision.Result>("visual-decision:edit", {
				id: this.id,
				...edit,
			});
			if (generation !== this.#generation) return;
			if (result.state) this.#accept(result.state);
			if (!result.ok) {
				if (result.reason === "saved") this.#queue = [];
				this.#blocked = true;
				this.#set({
					pending: this.#queue.length,
					error: result.message ?? "The change was not accepted. Try again.",
				});
				return;
			}
			// An accepted broadcast is not an acknowledgement of this particular edit.
			if (this.#queue[0]?.key === edit.key) this.#queue.shift();
			this.#set({ pending: this.#queue.length });
		} catch {
			if (generation !== this.#generation) return;
			this.#blocked = true;
			this.#set({ error: "The change is waiting to sync. Try again when connected." });
		} finally {
			if (generation === this.#generation) {
				this.#sending = false;
				void this.#flush();
			}
		}
	}

	#accept(raw: VisualDecision.State): void {
		if (raw.id !== this.id) return;
		let state = Visual.state(raw);
		let previous = this.#snapshot.state;
		if (previous && state.revision < previous.revision) return;
		if (previous?.saved && !state.saved) return;
		if (state.saved) this.#queue = [];
		this.#set({
			state,
			pending: this.#queue.length,
			...(previous && state.revision > previous.revision && !(this.#blocked && this.#queue.length)
				? { error: undefined }
				: {}),
		});
	}

	#set(change: Partial<VisualDecisionSnapshot>): void {
		this.#snapshot = { ...this.#snapshot, ...change };
		for (let listener of this.#listeners) listener();
	}
}
