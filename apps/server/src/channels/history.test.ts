import { describe, expect, test } from "bun:test";

import { MemoryStorage } from "../storage/memory/adapter";
import { DocumentHistory, VERSION_IDLE_MS } from "./history";

async function storage() {
	let storage = new MemoryStorage();
	let now = new Date("2026-10-14T10:00:00.000Z");
	await storage.users.put({ id: "U_mona", login: "mona", avatarUrl: "", now });
	await storage.users.put({ id: "U_hubot", login: "hubot", avatarUrl: "", now });
	await storage.channels.create({
		id: "channel",
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: "U_mona",
		now,
	});
	return storage;
}

describe("document history", () => {
	test("groups each author's edits into sessions and credits Chopin's own", async () => {
		let store = await storage();
		let now = new Date("2026-10-14T10:00:00.000Z");
		let history = new DocumentHistory(store, () => now);
		let edit = (revision: number, author?: string) =>
			history.record({
				channelId: "channel",
				revision,
				source: `# Plan ${revision}\n`,
				sourceHash: `hash-${revision}`,
				...(author ? { author } : {}),
			});

		await Promise.all([edit(1, "U_mona"), edit(2, "U_mona")]);
		now = new Date(now.getTime() + 60_000);
		await edit(3);
		await edit(4, "U_hubot");
		now = new Date(now.getTime() + VERSION_IDLE_MS + 1);
		await edit(5, "U_hubot");

		let versions = await store.versions.list("channel", 10);
		expect(versions.map(version => [version.revision, version.authorLogin])).toEqual([
			[5, "hubot"],
			[4, "hubot"],
			[3, undefined],
			[2, "mona"],
		]);
	});

	test("logs rather than throws when a version cannot be recorded", async () => {
		let store = await storage();
		let history = new DocumentHistory(store);
		await history.record({
			channelId: "missing",
			revision: 1,
			source: "# Plan\n",
			sourceHash: "hash",
		});
		await history.flush();
	});
});
