import { describe, expect, it } from "bun:test";

import {
	forgetChannel,
	readChannelRecovery,
	readDocumentRecovery,
	rememberChannel,
} from "./channel-recovery";

class MemoryStorage implements Storage {
	readonly #values = new Map<string, string>();

	get length(): number {
		return this.#values.size;
	}

	clear(): void {
		this.#values.clear();
	}

	getItem(key: string): string | null {
		return this.#values.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.#values.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.#values.delete(key);
	}

	setItem(key: string, value: string): void {
		this.#values.set(key, value);
	}
}

const channel = {
	id: "11111111-1111-4111-8111-111111111111",
	title: "Release readiness",
	slug: "release-readiness",
};

const repository = {
	owner: "octo-org",
	name: "score",
	fullName: "octo-org/score",
};

describe("channel recovery context", () => {
	it("keeps known channel and repository context in this tab", () => {
		let storage = new MemoryStorage();
		rememberChannel("U_octocat", channel, repository, storage);

		expect(readChannelRecovery("U_octocat", channel.id, storage)).toEqual({ channel, repository });
		expect(
			readDocumentRecovery(
				"U_octocat",
				repository.owner,
				repository.name,
				channel.slug,
				storage,
			),
		).toEqual({ channel, repository });
	});

	it("replaces the cached title after a document is renamed", () => {
		let storage = new MemoryStorage();
		rememberChannel("U_octocat", channel, repository, storage);
		rememberChannel("U_octocat", { ...channel, title: "Launch plan" }, repository, storage);

		expect(readChannelRecovery("U_octocat", channel.id, storage)?.channel.title).toBe(
			"Launch plan",
		);
	});

	it("forgets both recovery addresses after deletion", () => {
		let storage = new MemoryStorage();
		rememberChannel("U_octocat", channel, repository, storage);
		forgetChannel("U_octocat", {
			...channel,
			repositoryOwner: repository.owner,
			repositoryName: repository.name,
		}, storage);

		expect(readChannelRecovery("U_octocat", channel.id, storage)).toBeUndefined();
		expect(
			readDocumentRecovery(
				"U_octocat",
				repository.owner,
				repository.name,
				channel.slug,
				storage,
			),
		).toBeUndefined();
	});

	it("does not return another channel's context", () => {
		let storage = new MemoryStorage();
		rememberChannel("U_octocat", channel, repository, storage);

		expect(readChannelRecovery(
			"U_octocat",
			"22222222-2222-4222-8222-222222222222",
			storage,
		))
			.toBeUndefined();
	});

	it("does not return a previous user's context", () => {
		let storage = new MemoryStorage();
		rememberChannel("U_octocat", channel, repository, storage);

		expect(readChannelRecovery("U_other", channel.id, storage)).toBeUndefined();
	});

	it("restores UUID recovery records written before slugs were introduced", () => {
		let storage = new MemoryStorage();
		storage.setItem(
			`chopin:channel-recovery:${encodeURIComponent("U_octocat")}:${channel.id}`,
			JSON.stringify({ channel: { id: channel.id, title: channel.title }, repository }),
		);

		expect(readChannelRecovery("U_octocat", channel.id, storage)).toEqual({
			channel: { id: channel.id, title: channel.title },
			repository,
		});
		expect(
			readDocumentRecovery(
				"U_octocat",
				repository.owner,
				repository.name,
				channel.slug,
				storage,
			),
		).toBeUndefined();
	});

	it("ignores malformed stored context", () => {
		let storage = new MemoryStorage();
		storage.setItem(`chopin:channel-recovery:U_octocat:${channel.id}`, "not json");

		expect(readChannelRecovery("U_octocat", channel.id, storage)).toBeUndefined();
		storage.setItem(
			`chopin:channel-recovery:U_octocat:${channel.id}`,
			JSON.stringify({ channel: { ...channel, slug: { invalid: true } }, repository }),
		);
		expect(readChannelRecovery("U_octocat", channel.id, storage)).toBeUndefined();
	});
});
