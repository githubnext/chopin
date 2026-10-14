import { afterEach, expect, spyOn, test } from "bun:test";
import * as Service from "../plan/service";
import * as room from "../plan/room";
import { reconcile } from "./reconcile";
import { clientEdit, fixture, request } from "./provenance.test-fixtures";

let contexts: Awaited<ReturnType<typeof fixture>>[] = [];
async function opened() {
	let context = await fixture();
	contexts.push(context);
	return context;
}
afterEach(async () => {
	for (let context of contexts) await Service.close(context.plan);
	contexts = [];
});

function pending(plan: Service.Plan, messageId = "m2") {
	return {
		jobId: "job-1",
		input: {
			messageId,
			revision: plan.revision,
			decisionHash: room.digest("decisions"),
			source: room.project(plan.document),
			messages: [{ id: messageId, author: "ana", text: "A clearer account would help." }],
			passages: [],
			decisions: [],
			capacity: { additions: 48, characters: 12000 },
		},
	};
}

test("pending input survives restart and a matching completion clears it atomically", async () => {
	let context = await opened();
	context.plan.documentDevelopment!.pending = pending(context.plan);
	await Service.persist(context.plan);
	await Service.close(context.plan);
	context.plan = await Service.open(context.plan.id, context.backend, context.server);
	expect(context.plan.documentDevelopment!.pending?.input.messageId).toBe("m2");
	await reconcile(context.plan, request(context.plan), () => true);
	expect(context.plan.documentDevelopment!.pending).toBeUndefined();
	expect(context.plan.documentDevelopment!.lastOutcome).toBe("updated");
	let loaded = await context.storage.collaboration.load(context.plan.id, new Date());
	expect(loaded!.sidecar).toMatchObject({ documentDevelopment: { lastJobId: "job-1" } });
	expect((loaded!.sidecar as { documentDevelopment: object }).documentDevelopment)
		.not.toHaveProperty("pending");
});

test("completion cannot clear a newer admission", async () => {
	let { plan } = await opened();
	plan.documentDevelopment!.pending = pending(plan, "m3");
	await Service.persist(plan);
	await reconcile(plan, request(plan), () => true);
	expect(plan.documentDevelopment!.pending?.input.messageId).toBe("m3");
});

test("source, receipt and ownership remain private while storage has not committed", async () => {
	let { plan, storage, broadcasts } = await opened();
	let before = room.project(plan.document);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let original = storage.collaboration.commit.bind(storage.collaboration);
	let commit = spyOn(storage.collaboration, "commit").mockImplementation(async input => {
		entered.resolve();
		await release.promise;
		return original(input);
	});
	try {
		let publishing = reconcile(plan, request(plan), () => true);
		await entered.promise;
		expect(room.project(plan.document)).toBe(before);
		expect(plan.documentDevelopment!.lastJobId).toBeUndefined();
		expect(broadcasts).toEqual([]);
		release.resolve();
		await publishing;
		expect(plan.documentDevelopment!.lastJobId).toBe("job-1");
	} finally {
		release.resolve();
		commit.mockRestore();
	}
});

test.each(["replace", "delete"])(
	"a human edit during a delayed %s commit survives publication and restart",
	async operation => {
		let context = await opened();
		let { plan, storage } = context;
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let original = storage.collaboration.commit.bind(storage.collaboration);
		let commit = spyOn(storage.collaboration, "commit").mockImplementation(async input => {
			entered.resolve();
			await release.promise;
			return original(input);
		});
		try {
			let publishing = reconcile(
				plan,
				request(
					plan,
					operation === "delete"
						? { changes: [], removals: ["passage-1"] }
						: {},
				),
				() => true,
			);
			await entered.promise;
			await clientEdit(plan, { index: 1, text: "Human detail must survive." }, false);
			expect(plan.queue).toHaveLength(1);
			release.resolve();
			await publishing;
			await Service.drain(plan);
			expect(room.project(plan.document)).toContain("Human detail must survive.");
			await Service.close(plan);
			context.plan = await Service.open(plan.id, context.backend, context.server);
			expect(room.project(context.plan.document)).toContain("Human detail must survive.");
		} finally {
			release.resolve();
			commit.mockRestore();
		}
	},
);

test("present invalid provenance rejects a stored sidecar instead of granting fresh authority", async () => {
	let { plan, storage, lease, backend, server } = await opened();
	await Service.close(plan);
	let saved = await storage.collaboration.load(plan.id, new Date());
	await storage.collaboration.commit({
		channelId: plan.id,
		lease,
		expectedRevision: saved!.channel.revision,
		operationId: "corrupt-provenance",
		epoch: plan.document.epoch,
		sidecar: { ...(saved!.sidecar as object), documentDevelopment: { version: 1 } },
		events: [],
		now: new Date(),
	});
	await expect(Service.open(plan.id, backend, server)).rejects.toThrow("provenance");
	contexts = contexts.filter(context => context.plan !== plan);
});
