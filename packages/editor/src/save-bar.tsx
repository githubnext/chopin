/**
 * Save for the open decision cards this person answered, from the bottom of the pane.
 *
 * Each card still saves itself: the bar only calls the card's own submit, so
 * the shared-draft claim and persistence-before-publication stay per card.
 * Cards report themselves only once this person has chosen an answer on them,
 * so a collaborator's draft is never counted, cleared or saved from here.
 */

import { createContext, useEffect, useRef, useSyncExternalStore } from "react";

import type { PendingAnswers } from "@chopin/question/react";

export class PendingAnswersStore {
	#cards = new Map<string, PendingAnswers>();
	#snapshot: ReadonlyMap<string, PendingAnswers> = new Map();
	#listeners = new Set<() => void>();
	#submitted = new Set<string>();

	set = (card: string, pending: PendingAnswers | undefined): void => {
		if (pending) this.#cards.set(card, pending);
		else if (!this.#cards.delete(card)) return;
		this.#snapshot = new Map(this.#cards);
		for (let listener of this.#listeners) listener();
	};

	/** This client asked the server to save the card. */
	submitted = (card: string): void => {
		this.#submitted.add(card);
	};

	/** Whether this client saved the card, so its decision deserves a confirmation. */
	savedHere = (card: string): boolean => this.#submitted.has(card);

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
	/** Cards whose last save failed. */
	failed: string[];
	failedAnswers: number;
	/** Cards with some questions still unanswered. */
	incomplete: string[];
};

export function summarize(cards: Iterable<[string, PendingAnswers]>): SaveBarSummary {
	let summary: SaveBarSummary = {
		answered: 0,
		saveable: 0,
		submitting: false,
		failed: [],
		failedAnswers: 0,
		incomplete: [],
	};
	for (let [id, card] of cards) {
		summary.answered += card.answered;
		if (card.submitting) {
			summary.submitting = true;
			continue;
		}
		if (card.error) {
			summary.failed.push(id);
			summary.failedAnswers += card.answered;
		}
		if (card.complete) summary.saveable++;
		else summary.incomplete.push(id);
	}
	return summary;
}

export function unsavedLabel(answered: number): string {
	return answered === 1 ? "1 unsaved answer" : `${answered} unsaved answers`;
}

export function failedLabel(answered: number): string {
	return answered === 1 ? "Couldn’t save 1 answer" : `Couldn’t save ${answered} answers`;
}

export function incompleteLabel(cards: number): string {
	return cards === 1 ? "1 decision needs another answer" : `${cards} decisions need more answers`;
}

/** Cards that were saving and have come back with an error. */
export function newlyFailed(
	before: ReadonlySet<string>,
	cards: ReadonlyMap<string, PendingAnswers>,
): string[] {
	return [...before].filter(id => {
		let card = cards.get(id);
		return !!card && !card.submitting && !!card.error;
	});
}

export function SaveBar(
	{ onFailed, onFocusLeave, onIncomplete, store }: {
		/** Bring a card whose save failed into view, so its explanation is seen. */
		onFailed: (card: string) => void;
		onFocusLeave?: () => void;
		/** Take the reader to a card that still needs an answer. */
		onIncomplete: (card: string) => void;
		store: PendingAnswersStore;
	},
) {
	let cards = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
	let summary = summarize(cards);
	let open = summary.answered > 0 || summary.submitting;
	let bar = useRef<HTMLDivElement>(null);
	let saving = useRef<ReadonlySet<string>>(new Set());
	// The bar leaves with the words it arrived with rather than emptying first.
	let shown = useRef(summary);
	if (open) shown.current = summary;
	let { answered, failed, failedAnswers, incomplete, saveable, submitting } = shown.current;
	let waiting = saveable === 0 && incomplete.length > 0 && !submitting;

	useEffect(() => {
		let failedNow = newlyFailed(saving.current, cards);
		saving.current = new Set(
			[...cards].filter(([, card]) => card.submitting).map(([id]) => id),
		);
		if (failedNow[0]) onFailed(failedNow[0]);
	}, [cards, onFailed]);

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
			{failed.length > 0
				? (
					<span className="decision-save-bar-count" data-failed="" role="alert">
						{failedLabel(failedAnswers)}
					</span>
				)
				: (
					<span className="decision-save-bar-count" role="status">
						{waiting ? incompleteLabel(incomplete.length) : unsavedLabel(answered)}
					</span>
				)}
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
			{waiting
				? (
					<button
						className="btn btn-md btn-secondary decision-save-bar-button"
						onClick={() => incomplete[0] && onIncomplete(incomplete[0])}
						type="button"
					>
						Show
					</button>
				)
				: (
					<button
						className="btn btn-md btn-primary decision-save-bar-button"
						disabled={submitting || saveable === 0}
						onClick={() => {
							for (let card of cards.values()) {
								if (card.complete && !card.submitting) card.save();
							}
						}}
						type="button"
					>
						{submitting ? "Saving…" : failed.length > 0 ? "Try again" : "Save"}
					</button>
				)}
		</div>
	);
}
