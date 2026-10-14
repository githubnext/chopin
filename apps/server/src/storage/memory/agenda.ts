import { conflict, missing } from "../errors";
import type { AgendaRecord, AgendaRun, AgendaStore, SaveAgenda } from "../agenda";
import type { Lease } from "../model";

export class MemoryAgendaStore implements AgendaStore {
	#records = new Map<string, AgendaRecord>();
	#runs = new Map<string, AgendaRun>();
	constructor(
		private options: {
			exists: (id: string) => boolean;
			fence: (lease: Lease) => void;
		},
	) {}

	deleteChannel(id: string): void {
		this.#records.delete(id);
		for (let [key, run] of this.#runs) {
			if (run.channelId === id) this.#runs.delete(key);
		}
	}

	async get(id: string) {
		let found = this.options.exists(id) ? this.#records.get(id) : undefined;
		return found && structuredClone(found);
	}

	async save(input: SaveAgenda) {
		this.options.fence(input.lease);
		let id = input.record.channelId;
		if (!this.options.exists(id)) throw missing("agenda document does not exist");
		let current = this.#records.get(id);
		if ((current?.revision ?? 0) !== input.expectedRevision) throw conflict("agenda changed");
		if (input.record.revision !== input.expectedRevision + 1) {
			throw conflict("agenda revision invalid");
		}
		if (input.run) {
			if (input.run.channelId !== id || this.#runs.has(input.run.id)) {
				throw conflict("agenda request already exists");
			}
			this.#runs.set(input.run.id, structuredClone(input.run));
		}
		this.#records.set(id, structuredClone(input.record));
		return structuredClone(input.record);
	}

	async active() {
		return [...this.#records.values()]
			.filter(item => this.options.exists(item.channelId) && item.state === "active")
			.map(item => item.channelId).sort();
	}

	async run(channelId: string, requestId: string) {
		let run = this.#runs.get(requestId);
		return run?.channelId === channelId && this.options.exists(channelId)
			? structuredClone(run)
			: undefined;
	}

	async linkRun(input: Parameters<AgendaStore["linkRun"]>[0]) {
		this.options.fence(input.lease);
		let run = this.#runs.get(input.requestId);
		if (!run || run.channelId !== input.channelId || !this.options.exists(input.channelId)) {
			throw missing("agenda request does not exist");
		}
		if (run.workspaceId && run.workspaceId !== input.workspaceId) {
			throw conflict("agenda request already linked");
		}
		run.workspaceId = input.workspaceId;
	}
}
