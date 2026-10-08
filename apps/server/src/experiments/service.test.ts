import { expect, test } from "bun:test";
import { performance } from "@chopin/experiment/fixtures";
import { MemoryStorage } from "../storage/memory/adapter";
import { userAndChannel } from "../storage/contract-support";
import { Experiments } from "./service";

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
	let draft = await service.create(documentId, userId, "Measure startup");
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
