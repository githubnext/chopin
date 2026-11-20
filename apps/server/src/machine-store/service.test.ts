import { describe, expect, test } from "bun:test";

import { Machines } from "../auth/machines";
import { machine, owner } from "../storage/machine-contract";
import { testLease } from "../storage/contract-support";
import { MemoryStorage } from "../storage/memory/adapter";
import { FakeMachineStoreServer as FakeServer } from "./fake-server.test-fixtures";
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
		await expect(stores.login(laptop)).rejects.toThrow("turned off");
		await stores.sweep();
		expect(server.dropped.has(role)).toBe(false);
		advance(31 * DAY);
		await stores.sweep();
		expect(server.dropped.has(role)).toBe(true);
	});

	test("turn off a revoked machine's login at the next sweep when the server was down", async () => {
		let { server, stores, machines, userId, paired } = await setup();
		let laptop = await paired();
		let login = await stores.login(laptop);
		let role = new URL(login.url).username;
		server.refuse = "Chopin couldn't reach the database server";
		expect(await machines.revoke(laptop.id, userId)).toBe(true);
		expect(server.enabled.has(role)).toBe(true);
		delete server.refuse;
		await stores.sweep();
		expect(server.enabled.has(role)).toBe(false);
		await stores.sweep();
		expect(server.dropped.has(role)).toBe(false);
	});
});
