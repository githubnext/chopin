import { describe, expect, it } from "bun:test";

import { MemoryStorage } from "../storage/memory/adapter";
import { close, implementationGraphs, open } from "../plan/service";

import type { Server } from "bun";
import type { Backend } from "../plan/service";
import type { JsonValue } from "../storage/model";
import type { SocketData } from "../wire";

const now = new Date("2026-08-13T12:00:00.000Z");

async function hosted() {
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Implementation plan",
		createdBy: "U_octocat",
		now,
	});
	let lease = await storage.leases.acquire("writer", "graph-test", 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	let backend: Backend = {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	};
	let server = { publish() {} } as unknown as Server<SocketData>;
	return { storage, channel, lease, backend, server };
}

const definition = {
	tasks: [{
		id: "model",
		title: "Model graphs",
		context: "The sidecar owns the graph.",
		goal: "Persist implementation work.",
		acceptance: ["The graph is durable.", "The plan remains MDX only."],
		dependsOn: [],
	}],
};

describe("the plan graph adapter", () => {
	it("keeps a document graph in the hosted sidecar through a restart", async () => {
		let context = await hosted();
		let first = await open(context.channel.id, context.backend, context.server);

		let graph = await implementationGraphs().create(first, definition);
		expect(graph.ok).toBe(true);
		await close(first);
		let stored = await context.storage.collaboration.load(context.channel.id, now);
		expect(stored?.sidecar).toMatchObject({
			graph: { versions: [{ state: "draft", planRevision: 0, definition }] },
		});

		let restored = await open(context.channel.id, context.backend, context.server);
		expect((await implementationGraphs().edit(restored, definition)).ok).toBe(true);
		await close(restored);
	});

	it("ignores a malformed graph record while reopening the document", async () => {
		let context = await hosted();
		let first = await open(context.channel.id, context.backend, context.server);
		await close(first);
		let stored = await context.storage.collaboration.load(context.channel.id, now);
		if (
			!stored?.snapshot
			|| !stored.snapshot.sidecar
			|| typeof stored.snapshot.sidecar !== "object"
		) {
			throw new Error("channel was not initialized");
		}
		await context.storage.collaboration.commit({
			channelId: context.channel.id,
			lease: context.lease,
			expectedRevision: stored.channel.revision,
			operationId: "malformed-graph",
			epoch: stored.snapshot.epoch,
			sidecar: { ...stored.snapshot.sidecar, graph: {} } as JsonValue,
			events: [],
			now,
		});

		let restored = await open(context.channel.id, context.backend, context.server);
		expect(await implementationGraphs().create(restored, definition)).toMatchObject({ ok: true });
		await close(restored);
	});
});
