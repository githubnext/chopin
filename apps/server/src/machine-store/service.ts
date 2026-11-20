import { hkdfSync } from "node:crypto";

import { MACHINE_STORE_REASON_LIMIT } from "@chopin/protocol/machine-store";
import { decrypted, encrypted, imported } from "../auth/session";
import { machineStoreName, newStorePassword } from "./names";
import { MachineStoreRefusal } from "./server";

import type { MachineStoreLogin, MachineStoreStatus } from "@chopin/protocol/machine-store";
import type { StoredMachine, StoredMachineDatabase } from "../storage/model";
import type { StorageAdapter } from "../storage/port";
import type { MachineStoreServer } from "./server";

const CONTEXT = "chopin:machine-database:v1";

type Options = {
	storage: StorageAdapter;
	server: MachineStoreServer;
	key: Uint8Array;
	clock: () => Date;
	retentionMs?: number;
};

function reasonOf(error: unknown): string {
	let text = error instanceof MachineStoreRefusal
		? error.message
		: "Chopin couldn't keep this machine's database login";
	return text.length > MACHINE_STORE_REASON_LIMIT
		? `${text.slice(0, MACHINE_STORE_REASON_LIMIT - 1)}…`
		: text;
}

export class MachineStores {
	readonly #options: Options;
	readonly #key: Promise<CryptoKey>;
	readonly #queues = new Map<string, Promise<unknown>>();
	readonly #reported = new Map<string, string | undefined>();

	constructor(options: Options) {
		this.#options = options;
		this.#key = imported(new Uint8Array(hkdfSync("sha256", options.key, "", CONTEXT, 32)));
	}

	login(machine: StoredMachine): Promise<MachineStoreLogin> {
		return this.#serial(machine.id, () => this.#login(machine));
	}

	rotate(machine: StoredMachine): Promise<void> {
		return this.#serial(machine.id, () => this.#rotate(machine));
	}

	async disable(machineId: string): Promise<void> {
		try {
			await this.#serial(machineId, () => this.#disable(machineId));
		} catch (error) {
			throw error instanceof MachineStoreRefusal ? error : new MachineStoreRefusal(reasonOf(error));
		}
	}

	async report(machineId: string, problem: string | undefined): Promise<void> {
		let reported = problem?.slice(0, MACHINE_STORE_REASON_LIMIT) || undefined;
		if (this.#reported.has(machineId) && this.#reported.get(machineId) === reported) return;
		let storage = this.#options.storage.machineDatabases;
		let kept = await storage.report(machineId, reported);
		if (!kept && reported) {
			await this.#serial(machineId, () => this.#stored(machineId));
			kept = await storage.report(machineId, reported);
		}
		if (kept) this.#reported.set(machineId, reported);
	}

	async statuses(machineIds: readonly string[]): Promise<Map<string, MachineStoreStatus>> {
		let records = await this.#options.storage.machineDatabases.many(machineIds);
		let found = new Map<string, MachineStoreStatus>(
			machineIds.map(id => [id, { state: "pending" }]),
		);
		for (let record of records) {
			if (record.state === "failed") {
				found.set(record.machineId, { state: "failed", reason: record.failure ?? "" });
			} else if (record.connectorProblem && ["ready", "pending"].includes(record.state)) {
				found.set(record.machineId, { state: "failed", reason: record.connectorProblem });
			} else if (record.state === "ready") {
				found.set(record.machineId, { state: "ready" });
			}
		}
		return found;
	}

	async sweep(): Promise<void> {
		let now = this.#options.clock();
		let retention = this.#options.retentionMs;
		let dropBefore = retention === undefined ? undefined : new Date(now.getTime() - retention);
		for (let record of await this.#options.storage.machineDatabases.settling(dropBefore)) {
			try {
				if (record.state === "disabled") {
					await this.#serial(record.machineId, () => this.#drop(record.machineId));
				} else await this.disable(record.machineId);
			} catch (error) {
				console.error(
					`chopin: could not settle the database login of machine ${record.machineId} -`,
					reasonOf(error),
				);
			}
		}
	}

	async close(): Promise<void> {
		await Promise.allSettled(this.#queues.values());
		await this.#options.server.close();
	}

	#serial<T>(machineId: string, action: () => Promise<T>): Promise<T> {
		let result = (this.#queues.get(machineId) ?? Promise.resolve()).then(action);
		let settled = result.then(() => {}, () => {});
		this.#queues.set(machineId, settled);
		void settled.then(() => {
			if (this.#queues.get(machineId) === settled) this.#queues.delete(machineId);
		});
		return result;
	}

	#aad(record: Pick<StoredMachineDatabase, "machineId" | "role">, revision: number) {
		return JSON.stringify([CONTEXT, record.machineId, record.role, revision]);
	}

	async #seal(record: Pick<StoredMachineDatabase, "machineId" | "role">, revision: number) {
		let password = newStorePassword();
		let ciphertext = await encrypted(await this.#key, this.#aad(record, revision), { password });
		return { password, ciphertext };
	}

	async #open(
		record: Pick<StoredMachineDatabase, "machineId" | "role">,
		revision: number,
		ciphertext: Uint8Array,
	): Promise<string | undefined> {
		try {
			let value = await decrypted(await this.#key, this.#aad(record, revision), ciphertext);
			let password = (value as { password?: unknown } | undefined)?.password;
			return typeof password === "string" && password ? password : undefined;
		} catch {
			return undefined;
		}
	}

	async #put(record: StoredMachineDatabase) {
		if (!await this.#options.storage.machineDatabases.put(record)) {
			throw new MachineStoreRefusal("this machine's database login changed while Chopin kept it");
		}
	}

	async #stored(machineId: string): Promise<StoredMachineDatabase> {
		let storage = this.#options.storage.machineDatabases;
		let record = await storage.get(machineId);
		if (record) return record;
		let identity = { machineId, role: machineStoreName(machineId) };
		let { ciphertext } = await this.#seal(identity, 1);
		return storage.claim({
			...identity,
			revision: 1,
			ciphertext,
			state: "pending",
			updatedAt: this.#options.clock(),
		});
	}

	async #settled(record: StoredMachineDatabase): Promise<StoredMachineDatabase> {
		let candidate = record.candidate;
		if (!candidate) return record;
		let password = await this.#open(record, candidate.revision, candidate.ciphertext);
		let accepted = password === undefined
			? false
			: await this.#options.server.accepts(record.role, password);
		if (accepted === undefined) return record;
		let { candidate: _, ...rest } = record;
		let next: StoredMachineDatabase = accepted
			? { ...rest, revision: candidate.revision, ciphertext: candidate.ciphertext }
			: rest;
		next.updatedAt = this.#options.clock();
		await this.#put(next);
		return next;
	}

	async #paired(machineId: string): Promise<void> {
		let machine = await this.#options.storage.machines.get(machineId);
		if (!machine || machine.revokedAt) {
			throw new MachineStoreRefusal("this machine is no longer paired with Chopin");
		}
	}

	async #login(machine: StoredMachine): Promise<MachineStoreLogin> {
		await this.#paired(machine.id);
		let record = await this.#settled(await this.#stored(machine.id));
		if (record.state === "disabled" || record.state === "dropped") {
			throw new MachineStoreRefusal("this machine's database login is turned off");
		}
		let password = await this.#open(record, record.revision, record.ciphertext);
		if (password === undefined) {
			let revision = Math.max(record.revision, record.candidate?.revision ?? 0) + 1;
			let sealed = await this.#seal(record, revision);
			password = sealed.password;
			let { candidate: _, failure: __, ...rest } = record;
			record = { ...rest, revision, ciphertext: sealed.ciphertext, state: "pending" };
			await this.#put(record);
		}
		if (record.state !== "ready") {
			try {
				await this.#options.server.provision(record.role, password);
			} catch (error) {
				await this.#put({
					...record,
					state: "failed",
					failure: reasonOf(error),
					updatedAt: this.#options.clock(),
				});
				throw error instanceof MachineStoreRefusal
					? error
					: new MachineStoreRefusal(reasonOf(error));
			}
			let { failure: _, candidate: __, ...ready } = record;
			await this.#put({ ...ready, state: "ready", updatedAt: this.#options.clock() });
		}
		return { url: this.#options.server.loginUrl(record.role), password };
	}

	async #rotate(machine: StoredMachine): Promise<void> {
		await this.#paired(machine.id);
		let record = await this.#settled(await this.#stored(machine.id));
		if (record.state === "disabled" || record.state === "dropped") {
			throw new MachineStoreRefusal("this machine's database login is turned off");
		}
		if (record.candidate) {
			throw new MachineStoreRefusal(
				"the database server hasn't confirmed this machine's last password change yet; "
					+ "try again once it answers",
			);
		}
		let revision = record.revision + 1;
		let sealed = await this.#seal(record, revision);
		let rotating: StoredMachineDatabase = {
			...record,
			candidate: { revision, ciphertext: sealed.ciphertext },
			updatedAt: this.#options.clock(),
		};
		await this.#put(rotating);
		try {
			if (record.state === "ready") {
				await this.#options.server.setPassword(record.role, sealed.password);
			} else await this.#options.server.provision(record.role, sealed.password);
		} catch (error) {
			await this.#settled(rotating).catch(() => {});
			throw error instanceof MachineStoreRefusal ? error : new MachineStoreRefusal(reasonOf(error));
		}
		let { candidate: _, failure: __, ...rest } = rotating;
		await this.#put({
			...rest,
			revision,
			ciphertext: sealed.ciphertext,
			state: "ready",
			updatedAt: this.#options.clock(),
		});
	}

	async #disable(machineId: string): Promise<void> {
		let record = await this.#options.storage.machineDatabases.get(machineId);
		if (!record || record.state === "disabled" || record.state === "dropped") return;
		await this.#options.server.disable(record.role);
		let { candidate: _, failure: __, ...rest } = record;
		let now = this.#options.clock();
		await this.#put({ ...rest, state: "disabled", disabledAt: now, updatedAt: now });
	}

	async #drop(machineId: string): Promise<void> {
		let record = await this.#options.storage.machineDatabases.get(machineId);
		if (!record || record.state !== "disabled") return;
		await this.#options.server.drop(record.role);
		let now = this.#options.clock();
		await this.#put({ ...record, state: "dropped", droppedAt: now, updatedAt: now });
	}
}
