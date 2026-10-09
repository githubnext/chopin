import { investigationSchema } from "@chopin/experiment/records";
import type { Investigation } from "@chopin/experiment/records";
import type { ExperimentStore } from "../experiments";
import type { Lease } from "../model";
import { conflict, missing } from "../errors";

export class MemoryExperimentStore implements ExperimentStore {
	#records = new Map<string, Investigation>();
	constructor(
		private options: {
			exists: (id: string) => boolean;
			active: (id: string) => boolean;
			fence: (lease: Lease) => void;
		},
	) {}
	async get(id: string) {
		let value = this.#records.get(id);
		return value && this.options.exists(value.documentId) ? structuredClone(value) : undefined;
	}
	async list(documentId: string) {
		if (!this.options.exists(documentId)) return [];
		return [...this.#records.values()].filter(value => value.documentId === documentId)
			.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(value => structuredClone(value));
	}
	async active() {
		return [...this.#records.values()].filter(value =>
			this.options.exists(value.documentId)
			&& ["queued", "running", "publishing"].includes(value.state)
		)
			.map(value => structuredClone(value));
	}
	async save(value: Investigation, expected: number | undefined, lease: Lease) {
		this.options.fence(lease);
		if (!this.options.exists(value.documentId)) throw missing("experiment document not found");
		if (
			!this.options.active(value.documentId)
			&& !["failed", "cancelled", "interrupted"].includes(value.state)
		) throw conflict("experiment document archived");
		let previous = this.#records.get(value.id);
		if (previous?.revision !== expected) return false;
		if (
			value.revision !== (expected === undefined ? 0 : expected + 1)
			|| previous && previous.documentId !== value.documentId
		) throw conflict("invalid experiment revision");
		this.#records.set(value.id, structuredClone(investigationSchema.parse(value)));
		return true;
	}
}
