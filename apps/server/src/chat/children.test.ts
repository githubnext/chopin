import { afterEach, expect, test } from "bun:test";

import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { createChildDocuments } from "./children";

import type { Plan } from "../plan/service";
import type { ChannelRecord } from "../storage/model";

let plans: Plan[] = [];
afterEach(async () => {
	for (let plan of plans.splice(0)) await Service.close(plan);
});

async function fixture() {
	let opened = await openPlan("# Child report\n\nOriginal finding.\n", { parent: "Root" });
	plans.push(opened.plan);
	let storage = opened.backend.storage;
	let rootId = opened.channel.parentChannelId!;
	let fields = {
		repositoryId: "R_test",
		repositoryOwner: "owner",
		repositoryName: "repository",
		createdBy: "U_test",
		now: new Date("2026-08-13T12:00:00.000Z"),
	};
	let otherRoot = await storage.channels.create({
		...fields,
		id: crypto.randomUUID(),
		title: "Other",
	});
	let foreign = await storage.channels.create({
		...fields,
		id: crypto.randomUUID(),
		title: "Another root's child",
		parentChannelId: otherRoot.id,
	});
	let opens: string[] = [];
	let children = createChildDocuments({
		rootId,
		repositoryId: "R_test",
		channels: storage.channels,
		server: opened.server,
		withChildPlan: async (childId, action) => {
			opens.push(childId);
			if (childId !== opened.channel.id) throw new Error("unexpected child opened");
			return action(opened.plan);
		},
	});
	return { ...opened, storage, rootId, otherRoot, foreign, children, opens };
}

test("lists and resolves only this root's unarchived children", async () => {
	let { children, channel, rootId, otherRoot, foreign } = await fixture();
	expect(await children.list()).toEqual([
		{ id: channel.id, title: "Test plan", createdAt: channel.createdAt.toISOString() },
	]);
	expect((await children.resolve(channel.id))?.id).toBe(channel.id);
	for (let refused of [rootId, otherRoot.id, foreign.id, crypto.randomUUID(), "not-an-id"]) {
		expect(await children.resolve(refused)).toBeUndefined();
	}
});

test("open hands over a child room bound to the child's own plan and topic", async () => {
	let { children, channel, plan, opens } = await fixture();
	let seen = await children.open(
		channel.id,
		async child => ({ id: child.id, same: child.plan === plan }),
	);
	expect(seen).toEqual({ id: channel.id, same: true });
	expect(opens).toEqual([channel.id]);
});

test("open refuses a foreign child without opening its room", async () => {
	let { children, foreign, opens } = await fixture();
	await expect(children.open(foreign.id, async () => "opened")).rejects.toThrow(
		"no such child document of this document",
	);
	expect(opens).toEqual([]);
});

test("open rechecks after the child's transition is held, so a racing archive wins", async () => {
	let opened = await fixture();
	let children = createChildDocuments({
		rootId: opened.rootId,
		repositoryId: "R_test",
		channels: opened.storage.channels,
		server: opened.server,
		withChildPlan: async (childId, action) => {
			await opened.storage.channels.archive({ id: childId, now: new Date() });
			return action(opened.plan);
		},
	});
	let ran = false;
	await expect(children.open(opened.channel.id, async () => {
		ran = true;
	})).rejects.toThrow("no such child document of this document");
	expect(ran).toBe(false);
});

test("an archived root exposes no children", async () => {
	let { children, storage, rootId, channel } = await fixture();
	await storage.channels.archive({ id: rootId, now: new Date() });
	expect(await children.list()).toEqual([]);
	expect(await children.resolve(channel.id)).toBeUndefined();
});

test("a child in another repository is refused even under the same parent id", async () => {
	let { storage, rootId, server } = await fixture();
	let children = createChildDocuments({
		rootId,
		repositoryId: "R_other",
		channels: storage.channels,
		server,
		withChildPlan: async () => {
			throw new Error("must not open");
		},
	});
	expect(await children.list()).toEqual([]);
});

test("a child whose stored repository differs from the root's is refused and never opened", async () => {
	let opened = await fixture();
	let drifted = (record: ChannelRecord) =>
		record.id === opened.channel.id ? { ...record, repositoryId: "R_other" } : record;
	let opens: string[] = [];
	let children = createChildDocuments({
		rootId: opened.rootId,
		repositoryId: "R_test",
		channels: {
			get: async id => {
				let record = await opened.storage.channels.get(id);
				return record && drifted(record);
			},
			children: async (parentId, limit) =>
				(await opened.storage.channels.children(parentId, limit)).map(drifted),
		},
		server: opened.server,
		withChildPlan: async (childId, action) => {
			opens.push(childId);
			return action(opened.plan);
		},
	});
	expect(await children.list()).toEqual([]);
	expect(await children.resolve(opened.channel.id)).toBeUndefined();
	await expect(children.open(opened.channel.id, async () => "opened")).rejects.toThrow(
		"no such child document of this document",
	);
	expect(opens).toEqual([]);
});
