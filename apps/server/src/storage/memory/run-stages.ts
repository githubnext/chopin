import { missing } from "../errors";

import type { PutRunStages, RunStageRecord } from "../model";
import type { RunStageStore } from "../port";

function copy(stage: RunStageRecord): RunStageRecord {
	return { ...stage, ...(stage.parentIds ? { parentIds: [...stage.parentIds] } : {}) };
}

export class MemoryRunStageStore implements RunStageStore {
	/** Per document, per run: stages by id, in the order they were first added. */
	#runs = new Map<string, Map<string, Map<string, RunStageRecord>>>();
	constructor(private channelExists: (id: string) => boolean) {}
	async put(input: PutRunStages) {
		if (!this.channelExists(input.channelId)) {
			throw missing(`channel ${input.channelId} does not exist`);
		}
		let runs = this.#runs.get(input.channelId) ?? new Map();
		this.#runs.set(input.channelId, runs);
		let run: Map<string, RunStageRecord> = input.replace
			? new Map()
			: runs.get(input.runId) ?? new Map();
		runs.set(input.runId, run);
		for (let stage of input.stages) run.set(stage.id, copy(stage));
		return run.size;
	}
	async list(channelId: string, runId: string, page: { offset: number; limit: number }) {
		let run = [...this.#runs.get(channelId)?.get(runId)?.values() ?? []];
		return {
			stages: run.slice(page.offset, page.offset + page.limit).map(copy),
			total: run.length,
		};
	}
	async retain(channelId: string, runIds: string[]) {
		let runs = this.#runs.get(channelId);
		let keep = new Set(runIds);
		for (let runId of runs?.keys() ?? []) if (!keep.has(runId)) runs!.delete(runId);
	}
	deleteChannel(channelId: string) {
		this.#runs.delete(channelId);
	}
}
