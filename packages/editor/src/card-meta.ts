/** Server-owned state for decision cards, alongside their document nodes. */

import { forget } from "@chopin/question/react";
import { useSyncExternalStore } from "react";

import type { Question } from "@chopin/protocol";
import type { Transport as QuestionTransport } from "@chopin/question/react";
import type { Transport } from "./transport";

type Forget = (wire: Transport, id: string) => void;

const EMPTY: ReadonlyMap<string, Question.CardMeta> = new Map();

export class CardMetaStore {
	#cards: ReadonlyMap<string, Question.CardMeta> = EMPTY;
	#listeners = new Set<() => void>();
	#forget: Forget;
	// A history entry is appended on each reopen. Remember that generation per
	// transport so reconnect snapshots cannot retire the same live draft twice.
	#retired = new WeakMap<Transport, Map<string, number>>();

	constructor(onReopen: Forget = (wire, id) => forget(wire as unknown as QuestionTransport, id)) {
		this.#forget = onReopen;
	}

	subscribe = (listener: () => void): () => void => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	snapshot = (): ReadonlyMap<string, Question.CardMeta> => this.#cards;

	get(id: string): Question.CardMeta | undefined {
		return this.#cards.get(id);
	}

	listen(wire: Transport | undefined): () => void {
		if (!wire) {
			this.#replace(EMPTY);
			return () => {};
		}
		let off = [
			wire.on<Question.Metas>("question:metas", frame => {
				for (let { id, meta } of frame.cards) this.#retire(wire, id, meta);
				this.#replace(new Map(frame.cards.map(card => [card.id, card.meta])));
			}),
			wire.on<Question.Meta>("question:meta", frame => {
				this.#retire(wire, frame.id, frame.meta);
				let next = new Map(this.#cards);
				next.set(frame.id, frame.meta);
				this.#replace(next);
			}),
		];
		return () => {
			for (let stop of off) stop();
		};
	}

	#retire(wire: Transport, id: string, meta: Question.CardMeta): void {
		if (meta.status !== "reopened") return;
		let generations = this.#retired.get(wire);
		if (!generations) this.#retired.set(wire, generations = new Map());
		let generation = meta.history.length;
		if (generations.get(id) === generation) return;
		generations.set(id, generation);
		this.#forget(wire, id);
	}

	#replace(cards: ReadonlyMap<string, Question.CardMeta>): void {
		this.#cards = cards;
		for (let listener of this.#listeners) listener();
	}
}

export function useCardMeta(
	store: CardMetaStore | undefined,
	id: string,
): Question.CardMeta | undefined {
	let cards = useSyncExternalStore(
		store?.subscribe ?? noop,
		store?.snapshot ?? empty,
		store?.snapshot ?? empty,
	);
	return cards.get(id);
}

function noop() {
	return () => {};
}

function empty() {
	return EMPTY;
}
