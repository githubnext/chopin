/**
 * Save for every open decision card at once, from the bottom of the pane.
 *
 * Each card still saves itself: the bar only calls the card's own submit, so
 * the shared-draft claim and persistence-before-publication stay per card.
 */

import { createContext, useEffect, useRef, useSyncExternalStore } from "react";

import type { PendingAnswers } from "@chopin/question/react";

export class PendingAnswersStore {
	#cards = new Map<string, PendingAnswers>();
	#snapshot: ReadonlyMap<string, PendingAnswers> = new Map();
	#listeners = new Set<() => void>();

	set = (card: string, pending: PendingAnswers | undefined): void => {
		if (pending) this.#cards.set(card, pending);
		else if (!this.#cards.delete(card)) return;
		this.#snapshot = new Map(this.#cards);
		for (let listener of this.#listeners) listener();
	};

	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	snapshot = (): ReadonlyMap<string, PendingAnswers> => this.#snapshot;
}

/** Present only where a save bar is shown; cards elsewhere keep their own Save. */
export const PendingAnswersContext = createContext<PendingAnswersStore | undefined>(undefined);

export type SaveBarSummary = {
	answered: number;
	saveable: number;
	submitting: boolean;
};

export function summarize(cards: Iterable<PendingAnswers>): SaveBarSummary {
	let summary = { answered: 0, saveable: 0, submitting: false };
	for (let card of cards) {
		summary.answered += card.answered;
		if (card.submitting) summary.submitting = true;
		else if (card.complete) summary.saveable++;
	}
	return summary;
}

export function unsavedLabel(answered: number): string {
	return answered === 1 ? "1 unsaved answer" : `${answered} unsaved answers`;
}

export function SaveBar(
	{ onFocusLeave, store }: { onFocusLeave?: () => void; store: PendingAnswersStore },
) {
	let cards = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
	let summary = summarize(cards.values());
	let open = summary.answered > 0 || summary.submitting;
	let bar = useRef<HTMLDivElement>(null);
	// The bar leaves with the words it arrived with rather than emptying first.
	let shown = useRef(summary);
	if (open) shown.current = summary;
	let { answered, saveable, submitting } = shown.current;

	useEffect(() => {
		if (open || !bar.current?.contains(document.activeElement)) return;
		onFocusLeave?.();
	}, [open, onFocusLeave]);

	return (
		<div
			aria-hidden={open ? undefined : true}
			aria-label="Unsaved answers"
			className="decision-save-bar"
			data-open={open ? "" : undefined}
			inert={!open}
			ref={bar}
			role="region"
		>
			<span className="decision-save-bar-count" role="status">
				{unsavedLabel(answered)}
			</span>
			<button
				className="btn btn-md btn-ghost decision-save-bar-button"
				disabled={submitting}
				onClick={() => {
					for (let card of cards.values()) if (!card.submitting) card.clear();
				}}
				type="button"
			>
				Clear
			</button>
			<button
				className="btn btn-md btn-primary decision-save-bar-button"
				disabled={submitting || saveable === 0}
				onClick={() => {
					for (let card of cards.values()) if (card.complete && !card.submitting) card.save();
				}}
				type="button"
			>
				{submitting ? "Saving…" : "Save"}
			</button>
		</div>
	);
}
