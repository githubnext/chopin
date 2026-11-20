import { describe, expect, test } from "bun:test";

import { MachineCutoffError, Machines } from "../auth/machines";
import { machine, owner } from "../storage/machine-contract";
import { testLease } from "../storage/contract-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { FakeMachineStoreServer as FakeServer } from "./fake-server.test-fixtures";
import { machineStoreName } from "./names";
import { MachineStores } from "./service";

import type { StoredMachine } from "../storage/model";

const KEY = new Uint8Array(32).fill(7);
const DAY = 86_400_000;

async function setup(retentionMs?: number) {
	let storage = new MemoryStorage();
	await storage.migrate();
	let server = new FakeServer();
	let now = new Date("2026-01-02T03:04:05.000Z");
	let clock = () => now;
	let stores = new MachineStores({
		storage,
		server,
		key: KEY,
		clock,
		...(retentionMs === undefined ? {} : { retentionMs }),
	});
	let lease = await testLease(storage);
	let machines = new Machines(storage, clock, {
		origin: "https://chopin.example",
		clientId: "client",
		lease: () => lease,
		revoked: id => stores.disable(id),
	});
	let userId = await owner(storage);
	let paired = async () => {
		let input = machine(userId, { id: crypto.randomUUID() });
		await storage.machines.create(input);
		return (await storage.machines.get(input.id)) as StoredMachine;
	};
	return {
		storage,
		server,
		stores,
		machines,
		userId,
		paired,
		advance: (ms: number) => {
			now = new Date(now.getTime() + ms);
		},
	};
}

describe("machine database logins", () => {
	test("give a machine one login, the same on every ask, kept only encrypted", async () => {
		let { storage, server, stores, paired } = await setup();
		let laptop = await paired();
		expect((await stores.statuses([laptop.id])).get(laptop.id)).toEqual({ state: "pending" });
		let first = await stores.login(laptop);
		let role = `m_${laptop.id.replaceAll("-", "")}`;
		expect(first.url).toBe(`postgresql://${role}@db.example.com:5432/${role}?sslmode=verify-full`);
		expect(new URL(first.url).password).toBe("");
		expect(await stores.login(laptop)).toEqual(first);
		expect(server.calls).toEqual([`provision ${role}`]);
		let stored = (await storage.machineDatabases.get(laptop.id))!;
		expect(Buffer.from(stored.ciphertext).toString("latin1")).not.toContain(first.password);
		expect(JSON.stringify(stored)).not.toContain(first.password);
		expect((await stores.statuses([laptop.id])).get(laptop.id)).toEqual({ state: "ready" });
		let desk = await paired();
		let second = await stores.login(desk);
		expect(second.url).not.toBe(first.url);
		expect(second.password).not.toBe(first.password);
	});

	test("say why a login couldn't be made, and make it on the next ask", async () => {
		let { server, stores, paired } = await setup();
		let laptop = await paired();
		server.refuse = "a machine could still connect to the database template1";
		await expect(stores.login(laptop)).rejects.toThrow("template1");
		expect((await stores.statuses([laptop.id])).get(laptop.id)).toEqual({
			state: "failed",
			reason: "a machine could still connect to the database template1",
		});
		delete server.refuse;
		let login = await stores.login(laptop);
		expect(server.passwords.get(new URL(login.url).username)).toBe(login.password);
		expect((await stores.statuses([laptop.id])).get(laptop.id)).toEqual({ state: "ready" });
	});

	test("rotate to a new password that alone works from then on", async () => {
		let { server, stores, paired } = await setup();
		let laptop = await paired();
		let before = await stores.login(laptop);
		await stores.rotate(laptop);
		let after = await stores.login(laptop);
		expect(after.url).toBe(before.url);
		expect(after.password).not.toBe(before.password);
		let role = new URL(after.url).username;
		expect(await server.accepts(role, before.password)).toBe(false);
		expect(await server.accepts(role, after.password)).toBe(true);
	});

	test("keep the working login when a rotation is refused or interrupted", async () => {
		let { storage, server, stores, paired } = await setup();
		let laptop = await paired();
		let before = await stores.login(laptop);
		let role = new URL(before.url).username;
		server.refuse = "the server refused";
		await expect(stores.rotate(laptop)).rejects.toThrow("the server refused");
		delete server.refuse;
		expect((await storage.machineDatabases.get(laptop.id))!.candidate).toBeUndefined();
		expect(await stores.login(laptop)).toEqual(before);

		server.failAfterApplying = true;
		server.unreachable = true;
		await expect(stores.rotate(laptop)).rejects.toThrow("the connection dropped");
		server.failAfterApplying = false;
		expect((await storage.machineDatabases.get(laptop.id))!.candidate).toBeDefined();
		server.unreachable = false;
		let after = await stores.login(laptop);
		expect(after.password).not.toBe(before.password);
		expect(await server.accepts(role, after.password)).toBe(true);
		expect((await storage.machineDatabases.get(laptop.id))!.candidate).toBeUndefined();
	});

	test("refuse a rotation while the last one's outcome is unknown, keeping the login it set", async () => {
		let { storage, server, stores, paired } = await setup();
		let laptop = await paired();
		await stores.login(laptop);
		server.failAfterApplying = true;
		server.unreachable = true;
		await expect(stores.rotate(laptop)).rejects.toThrow("the connection dropped");
		server.failAfterApplying = false;
		let pending = (await storage.machineDatabases.get(laptop.id))!.candidate;
		expect(pending).toBeDefined();
		server.calls.length = 0;
		server.refuse = "the server refused";
		await expect(stores.rotate(laptop)).rejects.toThrow("hasn't confirmed");
		delete server.refuse;
		expect(server.calls).toEqual([]);
		expect((await storage.machineDatabases.get(laptop.id))!.candidate).toEqual(pending);
		server.unreachable = false;
		let login = await stores.login(laptop);
		expect(await server.accepts(new URL(login.url).username, login.password)).toBe(true);
	});

	test("serialize rotations of one machine", async () => {
		let { server, stores, paired } = await setup();
		let laptop = await paired();
		await stores.login(laptop);
		await Promise.all([stores.rotate(laptop), stores.rotate(laptop), stores.login(laptop)]);
		let login = await stores.login(laptop);
		expect(await server.accepts(new URL(login.url).username, login.password)).toBe(true);
	});

	test("turn a login off before a revocation returns, and drop it after the retention", async () => {
		let { server, stores, machines, userId, paired, advance } = await setup(30 * DAY);
		let laptop = await paired();
		let login = await stores.login(laptop);
		let role = new URL(login.url).username;
		expect(await machines.revoke(laptop.id, userId)).toBe(true);
		expect(server.enabled.has(role)).toBe(false);
		expect(await server.accepts(role, login.password)).toBe(false);
		await expect(stores.login(laptop)).rejects.toThrow("no longer paired");
		await stores.sweep();
		expect(server.dropped.has(role)).toBe(false);
		advance(31 * DAY);
		await stores.sweep();
		expect(server.dropped.has(role)).toBe(true);
	});

	test("refuse to call a revocation done until the login is off, and finish it later", async () => {
		let { server, stores, machines, userId, paired } = await setup();
		let laptop = await paired();
		let desk = await paired();
		let login = await stores.login(laptop);
		let role = new URL(login.url).username;
		await stores.login(desk);
		let deskRole = machineStoreName(desk.id);
		server.refuse = "Chopin couldn't reach the database server";
		let refused = await machines.revoke(laptop.id, userId).catch(error => error);
		expect(refused).toBeInstanceOf(MachineCutoffError);
		expect(refused.reason).toBe("Chopin couldn't reach the database server");
		expect(server.enabled.has(role)).toBe(true);
		await expect(machines.revoke(laptop.id, userId)).rejects.toBeInstanceOf(MachineCutoffError);
		delete server.refuse;
		expect(await machines.revoke(laptop.id, userId)).toBe(true);
		expect(server.enabled.has(role)).toBe(false);
		expect(await machines.revoke(laptop.id, "someone-else")).toBe(false);

		server.refuse = "Chopin couldn't reach the database server";
		await expect(machines.revoke(desk.id, userId)).rejects.toBeInstanceOf(MachineCutoffError);
		delete server.refuse;
		await stores.sweep();
		expect(server.enabled.has(deskRole)).toBe(false);
		await stores.sweep();
		expect(server.dropped.has(deskRole)).toBe(false);
	});

	test("give a machine revoked while it asked no login", async () => {
		let { storage, server, stores, machines, userId, paired } = await setup();
		let laptop = await paired();
		let role = machineStoreName(laptop.id);
		expect(await machines.revoke(laptop.id, userId)).toBe(true);
		await expect(stores.login(laptop)).rejects.toThrow("no longer paired");
		await expect(stores.rotate(laptop)).rejects.toThrow("no longer paired");
		expect(server.calls).toEqual([]);
		expect(server.enabled.has(role)).toBe(false);
		expect(await storage.machineDatabases.get(laptop.id)).toBeUndefined();

		let desk = await paired();
		let deskRole = machineStoreName(desk.id);
		let release!: () => void;
		server.provisioning = new Promise<void>(resolve => {
			release = resolve;
		});
		let asked = stores.login(desk);
		while (!server.calls.includes(`provision ${deskRole}`)) await Bun.sleep(1);
		let revoking = machines.revoke(desk.id, userId);
		release();
		await asked;
		expect(await revoking).toBe(true);
		expect(server.enabled.has(deskRole)).toBe(false);
	});

	test("keep a setup problem the machine reported, across restarts, until it reports none", async () => {
		let { storage, stores, paired } = await setup();
		let laptop = await paired();
		await stores.login(laptop);
		await stores.report(laptop.id, "Couldn't install the storage adapter");
		let restarted = new MachineStores({
			storage,
			server: new FakeServer(),
			key: KEY,
			clock: () => new Date(),
		});
		expect((await restarted.statuses([laptop.id])).get(laptop.id)).toEqual({
			state: "failed",
			reason: "Couldn't install the storage adapter",
		});
		await stores.login(laptop);
		expect((await restarted.statuses([laptop.id])).get(laptop.id)).toMatchObject({
			state: "failed",
		});
		await restarted.report(laptop.id, undefined);
		expect((await restarted.statuses([laptop.id])).get(laptop.id)).toEqual({ state: "ready" });
	});
});
