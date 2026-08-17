import { expect, it } from "bun:test";

import * as Service from "./service";
import { MemoryStorage } from "../storage/memory/adapter";

import type { Server } from "bun";
import type { Brief, CreationOrigin } from "../mcp";
import type { SocketData } from "../wire";

const now = new Date("2026-08-17T15:00:00.000Z");
const brief: Brief = {
	goal: "Create a collaborative plan.",
	constraints: ["Keep the initial source canonical."],
	settledDecisions: ["Use hosted storage."],
	openQuestions: ["Who reviews the rollout?"],
	repositoryFindings: ["The repository uses Bun."],
};
const origin: CreationOrigin = {
	idempotencyKey: "create-plan-1",
	fingerprint: "request-1",
	repository: "octo-org/score",
	baseBranch: "main",
	baseCommit: "0123456789abcdef0123456789abcdef01234567",
	title: "Created plan",
};

async function created(): Promise<MemoryStorage> {
	let storage = new MemoryStorage();
	await storage.users.put({
		id: "U_octocat",
		login: "octocat",
		avatarUrl: "https://example.test/octocat",
		now,
	});
	let initial = await Service.initial("# Created\n", origin, brief);
	await storage.channels.create({
		id: "created-plan",
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Created plan",
		createdBy: "U_octocat",
		now,
		initial,
	});
	return storage;
}

it("restores an MCP-created plan with its brief and provenance", async () => {
	let storage = await created();
	let stored = await storage.collaboration.load("created-plan", now);
	if (!stored) throw new Error("created plan was not stored");

	expect(await Service.readStored(stored)).toEqual({
		source: "# Created\n",
		revision: 0,
		brief,
		origin,
	});
});

it("retains creation metadata after the plan is persisted", async () => {
	let storage = await created();
	let lease = await storage.leases.acquire("channel-writer", "creation-test", 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	let backend: Service.Backend = {
		storage,
		lease: () => lease,
		fatal: error => {
			throw error;
		},
	};
	let server = { publish() {} } as unknown as Server<SocketData>;
	let plan = await Service.open("created-plan", backend, server);
	plan.revision = 1;
	await Service.persist(plan);
	await Service.close(plan);
	let stored = await storage.collaboration.load("created-plan", now);
	if (!stored) throw new Error("created plan was not stored");

	expect(await Service.readStored(stored)).toMatchObject({ brief, origin });
});
