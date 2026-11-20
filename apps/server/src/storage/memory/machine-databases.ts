import { conflict, missing } from "../errors";

import type { StoredMachineDatabase } from "../model";
import type { MachineDatabaseStore } from "../port";

function copy(value: StoredMachineDatabase): StoredMachineDatabase {
	return {
		...value,
		ciphertext: new Uint8Array(value.ciphertext),
		...(value.candidate
			? {
				candidate: {
					revision: value.candidate.revision,
					ciphertext: new Uint8Array(value.candidate.ciphertext),
				},
			}
			: {}),
		updatedAt: new Date(value.updatedAt),
		...(value.disabledAt ? { disabledAt: new Date(value.disabledAt) } : {}),
		...(value.droppedAt ? { droppedAt: new Date(value.droppedAt) } : {}),
	};
}

export class MemoryMachineDatabaseStore implements MachineDatabaseStore {
	#records = new Map<string, StoredMachineDatabase>();
	constructor(
		private deps: {
			machineExists: (id: string) => boolean;
			machineRevoked: (id: string) => boolean;
		},
	) {}
	async get(machineId: string) {
		let found = this.#records.get(machineId);
		return found && copy(found);
	}
	async many(machineIds: readonly string[]) {
		return machineIds.flatMap(id => {
			let found = this.#records.get(id);
			return found ? [copy(found)] : [];
		});
	}
	async claim(record: StoredMachineDatabase) {
		if (!this.deps.machineExists(record.machineId)) {
			throw missing(`machine ${record.machineId} does not exist`);
		}
		let existing = this.#records.get(record.machineId);
		if (existing) return copy(existing);
		if ([...this.#records.values()].some(value => value.role === record.role)) {
			throw conflict(`role ${record.role} is another machine's`);
		}
		this.#records.set(record.machineId, copy(record));
		return copy(record);
	}
	async put(record: StoredMachineDatabase) {
		let existing = this.#records.get(record.machineId);
		if (!existing || existing.role !== record.role) return false;
		let { connectorProblem: _, ...kept } = copy(record);
		this.#records.set(record.machineId, {
			...kept,
			...(existing.connectorProblem ? { connectorProblem: existing.connectorProblem } : {}),
		});
		return true;
	}
	async report(machineId: string, problem: string | undefined) {
		let existing = this.#records.get(machineId);
		if (!existing) return false;
		if (problem) existing.connectorProblem = problem;
		else delete existing.connectorProblem;
		return true;
	}
	async settling(dropBefore?: Date) {
		return [...this.#records.values()]
			.filter(value =>
				this.deps.machineRevoked(value.machineId)
					&& value.state !== "disabled" && value.state !== "dropped"
				|| !!dropBefore && value.state === "disabled" && !!value.disabledAt
					&& value.disabledAt <= dropBefore
			)
			.sort((a, b) => a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0)
			.map(copy);
	}
}
