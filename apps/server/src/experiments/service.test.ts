import { expect, test } from "bun:test";
import { performance } from "@chopin/experiment/fixtures";
import { MemoryStorage } from "../storage/memory/adapter";
import { userAndChannel } from "../storage/contract-support";
import { Experiments } from "./service";

test("required investigation keeps its build blocker through failure and retry", async () => {
	let storage = new MemoryStorage();
	let { channelId, userId, lease } = await userAndChannel(storage);
	let service = new Experiments(storage.experiments, () => lease);
	let value = await service.create(
		channelId,
		userId,
		"Measure startup",
		crypto.randomUUID(),
		undefined,
		"Choose a startup approach from measured evidence",
	);
	expect((await storage.experiments.get(value.id))?.buildBlocker)
		.toBe("Choose a startup approach from measured evidence");
	await service.stop(value.id, "failed", "Agent disconnected");
	expect((await service.retry(value.id)).buildBlocker)
		.toBe("Choose a startup approach from measured evidence");
});

test("reviewing an investigation refuses stale and cross-document updates", async () => {
	let storage = new MemoryStorage();
	let { channelId, userId, lease } = await userAndChannel(storage);
	let service = new Experiments(storage.experiments, () => lease);
	let value = await service.create(channelId, userId, "Measure startup");
	await service.setBuildBlocker(channelId, value.id, value.revision, "Choose an approach");
	await expect(service.setBuildBlocker(channelId, value.id, value.revision, null))
		.rejects.toThrow("revision-conflict");
	let current = (await storage.experiments.get(value.id))!;
	await expect(service.setBuildBlocker("other", value.id, current.revision, null))
		.rejects.toThrow("not-found");
	await service.setBuildBlocker(channelId, value.id, current.revision, null);
	expect((await storage.experiments.get(value.id))?.buildBlocker).toBeUndefined();
});

test("withdrawing an unstarted proposal clears its requirement but stopping a run retains it", async () => {
	let storage = new MemoryStorage();
	let { userId, lease } = await userAndChannel(storage);
	let documentId = crypto.randomUUID();
	await storage.channels.create({
		id: documentId,
		repositoryId: "repo",
		repositoryOwner: "org",
		repositoryName: "repo",
		title: "Investigation",
		createdBy: userId,
		now: new Date(),
	});
	let service = new Experiments(storage.experiments, () => lease);
	let create = () =>
		service.create(
			documentId,
			userId,
			"Measure startup",
			crypto.randomUUID(),
			undefined,
			"Choose approach",
		);
	let proposal = await create();
	expect((await service.stop(proposal.id, "cancelled")).buildBlocker).toBeUndefined();
	let running = await create();
	await service.authorize(running.id, "connection", {
		id: running.id,
		documentId,
		requester: userId,
		authorizer: userId,
		brief: running.brief,
		context: "",
		source: { repositoryId: "repo", repository: "org/repo", commit: "a".repeat(40) },
	});
	let claimed = await service.claim(running.id, "connection");
	expect((await service.stop(running.id, "cancelled")).buildBlocker).toBe("Choose approach");
	await service.retry(running.id);
	await service.authorize(running.id, "connection", { ...claimed.input! });
	let retry = await service.claim(running.id, "connection");
	await service.candidate(running.id, "connection", retry.generation, performance);
	let completed = await service.complete(running.id, "connection", retry.generation);
	expect(completed.buildBlocker).toBe("Choose approach");
	await service.setBuildBlocker(documentId, completed.id, completed.revision, null);
	expect((await storage.experiments.get(completed.id))?.buildBlocker).toBeUndefined();
});

test("claims expire, stale workers cannot publish and completion replays atomically", async () => {
	let storage = new MemoryStorage();
	let { channelId, userId, lease } = await userAndChannel(storage);
	let documentId = crypto.randomUUID();
	await storage.channels.create({
		id: documentId,
		repositoryId: "repo",
		repositoryOwner: "org",
		repositoryName: "repo",
		title: "Experiment",
		createdBy: userId,
		now: new Date(),
	});
	let now = Date.now();
	let published: string[] = [];
	let service = new Experiments(
		storage.experiments,
		() => lease,
		id => published.push(id),
		() => now,
	);
	let draft = await service.create(documentId, userId, "  Measure startup\n");
	let input = {
		id: draft.id,
		documentId,
		requester: userId,
		authorizer: userId,
		brief: draft.brief,
		context: "",
		source: { repositoryId: "repo", repository: "org/repo", commit: "a".repeat(40) },
	};
	await service.authorize(draft.id, "connection", input);
	await expect(service.claim(draft.id, "other")).rejects.toThrow("connection-forbidden");
	let claimed = await service.claim(draft.id, "connection");
	await service.candidate(draft.id, "connection", claimed.generation, performance);
	expect((await storage.experiments.get(draft.id))?.result).toBeUndefined();
	let completed = await service.complete(draft.id, "connection", claimed.generation);
	expect(completed.result).toEqual(performance);
	expect(completed.views.comparison.revision).toBe(0);
	expect(await service.complete(draft.id, "connection", claimed.generation)).toEqual(completed);
	let decisionId = crypto.randomUUID();
	await service.decide(draft.id, { id: "alice", login: "alice" }, {
		id: decisionId,
		view: "comparison",
		revision: 0,
		conclusion: "Choose cached",
		rationale: "Lower median",
	});
	await service.select(draft.id, "bob", "comparison", {
		mutationId: crypto.randomUUID(),
		expected: { "filter:workload": 0 },
		set: { "filter:workload": ["large"] },
	});
	let revised = (await service.store.get(draft.id))!;
	expect(revised.decisions[0].state.revision).toBe(0);
	expect(revised.views.comparison.revision).toBe(1);
	await expect(
		service.decide(draft.id, { id: "alice", login: "alice" }, {
			id: crypto.randomUUID(),
			view: "comparison",
			revision: 0,
			conclusion: "Stale",
			rationale: "",
		}),
	).rejects.toThrow("Shared selections changed");
	let another = await service.create(documentId, userId, "Try another");
	await service.authorize(another.id, "connection", {
		...input,
		id: another.id,
		brief: another.brief,
	});
	let running = await service.claim(another.id, "connection");
	now += 61_000;
	await expect(service.candidate(another.id, "connection", running.generation, performance)).rejects
		.toThrow("stale-claim");
	await service.recover();
	expect((await storage.experiments.get(another.id))?.state).toBe("interrupted");
	expect(published).not.toContain(channelId);
});

test("retry returns settled work to its card under the same identity and fences the old claim", async () => {
	let storage = new MemoryStorage();
	let { userId, lease } = await userAndChannel(storage);
	let documentId = crypto.randomUUID();
	await storage.channels.create({
		id: documentId,
		repositoryId: "repo",
		repositoryOwner: "org",
		repositoryName: "repo",
		title: "Experiment",
		createdBy: userId,
		now: new Date(),
	});
	let service = new Experiments(storage.experiments, () => lease);
	let draft = await service.create(documentId, userId, "Measure startup");
	await expect(service.retry(draft.id)).resolves.toMatchObject({ state: "requested" });
	let input = {
		id: draft.id,
		documentId,
		requester: userId,
		authorizer: userId,
		brief: draft.brief,
		context: "",
		source: { repositoryId: "repo", repository: "org/repo", commit: "a".repeat(40) },
	};
	await service.authorize(draft.id, "connection", input);
	let claimed = await service.claim(draft.id, "connection");
	await expect(service.retry(draft.id)).rejects.toThrow("invalid-state");
	await service.stop(draft.id, "failed", "Agent crashed.");
	let retried = await service.retry(draft.id);
	expect(retried).toMatchObject({ id: draft.id, state: "requested", progress: "" });
	expect(retried.input?.source).toEqual(input.source);
	expect(retried.connectionId).toBeUndefined();
	await expect(service.renew(draft.id, "connection", claimed.generation)).rejects.toThrow(
		"stale-claim",
	);
	await service.authorize(draft.id, "connection", input);
	expect((await service.claim(draft.id, "connection")).generation).toBe(claimed.generation + 1);
});
