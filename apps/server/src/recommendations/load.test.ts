import { afterEach, expect, it, spyOn } from "bun:test";

import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { createRecommendationLoader } from "./load";

let fixtures: Awaited<ReturnType<typeof openPlan>>[] = [];

afterEach(async () => {
	for (let fixture of fixtures) await Service.close(fixture.plan);
	fixtures = [];
});

async function fixture() {
	let context = await openPlan("# Decision discovery\n\nClarify how open decisions work.\n");
	fixtures.push(context);
	let options: Parameters<typeof createRecommendationLoader>[0] = {
		storage: context.storage,
		withPlan: async (_id, action) => action(context.plan),
		document: async () => undefined,
		investigations: async () => [],
		unavailable: () => false,
	};
	return { ...context, options };
}

it("loads committed human discussion and ignores an uncommitted change", async () => {
	let context = await fixture();
	let load = createRecommendationLoader(context.options);
	let before = await load(context.channel.id);
	context.plan.chat.entries.push({
		id: "changed-direction",
		author: { kind: "member", handle: "mona" },
		text: "Leave onboarding open; only explain the status.",
		ts: 1,
	});
	expect(await load(context.channel.id)).toEqual(before);
	await Service.persist(context.plan);
	let after = await load(context.channel.id);
	expect(after?.key).not.toBe(before?.key);
	expect(after?.evidence.some(item => item.detail.includes("Leave onboarding open"))).toBe(true);
});

it("uses the newest four published research children, including a fifth contradictory finding", async () => {
	let context = await fixture();
	let children = [];
	for (let index = 0; index < 5; index++) {
		children.push(
			await context.storage.channels.create({
				id: crypto.randomUUID(),
				title: `Research ${index}`,
				parentChannelId: context.channel.id,
				repositoryId: context.channel.repositoryId,
				repositoryOwner: context.channel.repositoryOwner,
				repositoryName: context.channel.repositoryName,
				createdBy: "U_test",
				now: context.now,
			}),
		);
	}
	let requests = children.toReversed().map(child => ({ publishedChannelId: child.id }));
	let list = spyOn(context.storage.research, "list").mockResolvedValue(requests as never);
	let contradiction = false;
	context.options.document = async id => ({
		channelId: id,
		revision: contradiction && id === children[4]!.id ? 2 : 1,
		source: contradiction && id === children[4]!.id
			? "People could not find the creation action."
			: "People found the creation action.",
		sourceHash: "fixture",
	});
	try {
		let load = createRecommendationLoader(context.options);
		let first = await load(context.channel.id);
		let ids = first!.evidence.filter(item => item.kind === "research").map(item => item.id);
		expect(ids).toEqual(children.toReversed().slice(0, 4).map(child => `research:${child.id}`));
		contradiction = true;
		let changed = await load(context.channel.id);
		expect(changed?.key).not.toBe(first?.key);
		expect(changed?.evidence.some(item => item.detail.includes("could not find"))).toBe(true);
		await context.storage.channels.archive({ id: children[4]!.id, now: context.now });
		let remaining = await load(context.channel.id);
		expect(remaining!.evidence.filter(item => item.kind === "research").map(item => item.id))
			.toEqual(children.slice(0, 4).toReversed().map(child => `research:${child.id}`));
	} finally {
		list.mockRestore();
	}
});

it("does not assess archived documents or a document being removed", async () => {
	let context = await fixture();
	let load = createRecommendationLoader(context.options);
	expect(await load(context.channel.id)).toBeDefined();
	context.options.unavailable = () => true;
	expect(await load(context.channel.id)).toBeUndefined();
	context.options.unavailable = () => false;
	await context.storage.channels.archive({ id: context.channel.id, now: context.now });
	expect(await load(context.channel.id)).toBeUndefined();
});

it("announces changed context only after a durable sidecar commit", async () => {
	let context = await fixture();
	let announced: string[] = [];
	context.plan.persistence.onContextPersisted = id => announced.push(id);
	context.plan.persistence.fatal = () => {};
	let commit = spyOn(context.storage.collaboration, "commit").mockRejectedValueOnce(
		new Error("storage unavailable"),
	);
	try {
		context.plan.chat.entries.push({
			id: "m1",
			author: { kind: "member", handle: "mona" },
			text: "Focus on the creation action.",
			ts: 1,
		});
		await expect(Service.persist(context.plan)).rejects.toThrow("storage unavailable");
		expect(announced).toEqual([]);
	} finally {
		commit.mockRestore();
	}
	await Service.persist(context.plan);
	expect(announced).toEqual([context.channel.id]);
});
