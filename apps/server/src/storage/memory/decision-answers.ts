import { missing } from "../errors";

import type { DecisionAnswer, SaveDecisionAnswer } from "../model";
import type { DecisionAnswerStore } from "../port";

type Row = DecisionAnswer & { deliveredAt?: Date };

function copy({ deliveredAt: _deliveredAt, ...row }: Row): DecisionAnswer {
	return { ...row, savedAt: new Date(row.savedAt) };
}

export class MemoryDecisionAnswerStore implements DecisionAnswerStore {
	/** Per document, per decision. */
	#rows = new Map<string, Map<string, Row>>();
	constructor(private channelExists: (id: string) => boolean) {}
	async save(input: SaveDecisionAnswer) {
		if (!this.channelExists(input.channelId)) {
			throw missing(`channel ${input.channelId} does not exist`);
		}
		let rows = this.#rows.get(input.channelId) ?? new Map<string, Row>();
		this.#rows.set(input.channelId, rows);
		let known = rows.get(input.decisionId);
		if (known && known.generation >= input.generation) return;
		rows.set(input.decisionId, {
			decisionId: input.decisionId,
			generation: input.generation,
			savedAt: new Date(input.savedAt),
		});
	}
	async pending(channelId: string) {
		return [...this.#rows.get(channelId)?.values() ?? []]
			.filter(row => !row.deliveredAt)
			.sort((a, b) =>
				a.savedAt.getTime() - b.savedAt.getTime() || a.decisionId.localeCompare(b.decisionId)
			)
			.map(copy);
	}
	async claim(
		channelId: string,
		turnId: string,
		answers: Array<{ decisionId: string; generation: number }>,
	) {
		let claimed = 0;
		for (let { decisionId, generation } of answers) {
			let row = this.#rows.get(channelId)?.get(decisionId);
			if (!row || row.deliveredAt || row.turnId || row.generation !== generation) continue;
			row.turnId = turnId;
			claimed++;
		}
		return claimed;
	}
	async release(channelId: string, turnId: string) {
		for (let row of this.#rows.get(channelId)?.values() ?? []) {
			if (row.turnId === turnId && !row.deliveredAt) delete row.turnId;
		}
	}
	async delivered(channelId: string, turnId: string, at: Date) {
		for (let row of this.#rows.get(channelId)?.values() ?? []) {
			if (row.turnId === turnId && !row.deliveredAt) row.deliveredAt = new Date(at);
		}
	}
	deleteChannel(channelId: string) {
		this.#rows.delete(channelId);
	}
}
