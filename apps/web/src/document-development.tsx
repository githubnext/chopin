import { useId, useSyncExternalStore } from "react";
import { PauseIcon, PencilIcon, PlayIcon } from "@chopin/icons";
import { IconButton } from "./icon-button";

import type { DocumentDevelopment } from "@chopin/protocol";
import type { Wire } from "./wire";
import "./document-development.css";

type Snapshot = { state?: DocumentDevelopment.State; changing: boolean; error?: string };

/** A document owns its state; neither reconnects nor old control replies carry it forward. */
export class DocumentDevelopmentStore {
	#snapshot: Snapshot = { changing: false };
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
		this.#set({ changing: false });
	}

	listen(wire: Wire): () => void {
		this.reset();
		this.#wire = wire;
		let off = wire.on<DocumentDevelopment.State>("document-development:state", state => {
			if (this.#wire !== wire) return;
			this.#set({ state, changing: this.#snapshot.changing });
		});
		return () => {
			off();
			if (this.#wire !== wire) return;
			this.#wire = undefined;
			this.reset();
		};
	}

	async control(paused: boolean): Promise<void> {
		let wire = this.#wire;
		if (!wire?.connected || !this.#snapshot.state || this.#snapshot.changing) return;
		let request = ++this.#request;
		this.#set({ ...this.#snapshot, changing: true, error: undefined });
		try {
			let state = await wire.ask<DocumentDevelopment.State>("document-development:control", {
				paused,
			});
			if (this.#wire !== wire || request !== this.#request) return;
			this.#set({ state, changing: false });
		} catch {
			if (this.#wire !== wire || request !== this.#request) return;
			this.#set({
				...this.#snapshot,
				changing: false,
				error: paused ? "Couldn't pause draft updates" : "Couldn't resume draft updates",
			});
		}
	}

	#set(value: Snapshot): void {
		this.#snapshot = value;
		for (let listener of this.#listeners) listener();
	}
}

export function DocumentDevelopmentControl(
	{ canEdit, connected, store }: {
		canEdit: boolean;
		connected: boolean;
		store: DocumentDevelopmentStore;
	},
) {
	let { state, changing, error } = useSyncExternalStore(store.subscribe, store.get, store.get);
	let descriptionId = useId();
	if (!state) return null;
	let label = error ?? (state.paused
		? "Draft updates paused"
		: state.pending
		? "Updating draft"
		: state.lastOutcome === "failed"
		? "Draft update failed"
		: state.generated > 0
		? "Provisional draft"
		: "Draft follows Chat");
	let explanation =
		"Chat develops provisional passages. Passages you edit stay protected from automatic updates.";
	if (error) explanation = "Check your connection and try the control again.";
	else if (state.lastOutcome === "failed" && !state.pending && !state.paused) {
		explanation += " A new Chat message can try another update.";
	}
	let action = state.paused ? "Resume draft updates" : "Pause draft updates";
	return (
		<div
			aria-label="Document draft updates"
			className="document-development flex min-w-0 items-center gap-1 text-sm text-text-tertiary"
			role="group"
		>
			<span
				aria-describedby={descriptionId}
				aria-label={label}
				className="flex min-w-0 items-center gap-1"
				data-tooltip={`${label}. ${explanation}`}
				role="status"
			>
				<PencilIcon
					aria-hidden="true"
					className="document-development-glyph shrink-0"
					size={14}
				/>
				<span className="min-w-0 truncate" data-status-label>{label}</span>
			</span>
			<span className="sr-only" id={descriptionId}>{explanation}</span>
			{canEdit && (
				<IconButton
					aria-busy={changing}
					aria-label={action}
					data-tooltip={action}
					disabled={!connected || changing}
					glyph="default"
					onClick={() => void store.control(!state.paused)}
					pending={changing}
					size="compact"
				>
					{state.paused
						? <PlayIcon aria-hidden="true" size={14} />
						: <PauseIcon aria-hidden="true" size={14} />}
				</IconButton>
			)}
		</div>
	);
}
