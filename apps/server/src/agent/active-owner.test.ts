import { describe, expect, it } from "bun:test";

import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import { MemoryStorage } from "../storage/memory/adapter";
import { ActiveOwnerBindings } from "./active-owner";

import type { AuthConfig } from "../auth/config";
import type { GitHub, GitHubTokenGrant, Repository } from "../github/client";

function grant(token: string): GitHubTokenGrant {
	return {
		accessToken: token,
		accessExpiresIn: 28_800,
		refreshToken: `refresh-${token}`,
		refreshExpiresIn: 86_400,
	};
}

async function context(options: {
	repositoryId?: string;
	push?: boolean;
} = {}) {
	let now = new Date("2026-08-21T12:00:00.000Z");
	let storage = new MemoryStorage();
	let userId = crypto.randomUUID();
	let channelId = crypto.randomUUID();
	await storage.users.put({ id: userId, login: "mona", avatarUrl: "", now });
	await storage.channels.create({
		id: channelId,
		repositoryId: "R_repository",
		repositoryOwner: "githubnext",
		repositoryName: "chopin",
		title: "Background work",
		createdBy: userId,
		now,
	});
	let sessions = new Sessions(storage, true, () => now);
	let issued = await sessions.issue(userId, grant("ghu_owner"));
	let repository: Repository = {
		id: options.repositoryId ?? "R_repository",
		owner: "githubnext",
		name: "chopin",
		fullName: "githubnext/chopin",
		private: true,
		url: "https://github.com/githubnext/chopin",
		defaultBranch: "main",
		permissions: { pull: true, push: options.push ?? true, admin: false },
	};
	let github = {
		repositoryAccess: async () => repository,
		invalidate: () => {},
	} as unknown as GitHub;
	let config: AuthConfig = {
		origin: "https://chopin.test",
		appSlug: "chopin-test",
		clientId: "client",
		clientSecret: "secret",
		encryptionKey: new Uint8Array(32),
	};
	let admission = new Admission(config, github, () => now.getTime());
	let bindings = new ActiveOwnerBindings({
		storage,
		sessions,
		github,
		admission,
		clock: () => now,
	});
	return {
		storage,
		sessions,
		bindings,
		channelId,
		sessionId: issued.id,
		now,
		advance(ms: number) {
			now = new Date(now.getTime() + ms);
		},
	};
}

describe("active Planner owner bindings", () => {
	it("does not claim an unowned channel", async () => {
		let value = await context();
		try {
			expect(await value.bindings.resolve(value.channelId)).toBeUndefined();
			expect((await value.storage.channels.readAgent(value.channelId, value.now))!.agent)
				.toBeUndefined();
		} finally {
			await value.storage.close();
		}
	});

	it("binds and revalidates the exact owner, credential, and repository", async () => {
		let value = await context();
		try {
			let ownership = await value.storage.channels.claimAgentOwner(
				value.channelId,
				value.sessionId,
				value.now,
			);
			let binding = await value.bindings.resolve(value.channelId);
			expect(binding).toMatchObject({
				channelId: value.channelId,
				ownerSessionId: value.sessionId,
				ownerGeneration: ownership.generation,
				credentialRevision: 1,
				token: "ghu_owner",
				repository: { id: "R_repository", defaultBranch: "main" },
			});
			expect(binding!.currentToken()).toBe("ghu_owner");
			expect(await binding!.revalidate()).toBe(true);

			value.bindings.revokeCredential(value.sessionId, 1);
			expect(binding!.signal.aborted).toBe(true);
			expect(binding!.currentToken()).toBeUndefined();
			expect(await binding!.revalidate()).toBe(false);
			binding!.release();
		} finally {
			await value.storage.close();
		}
	});

	it("invalidates a binding when ownership changes", async () => {
		let value = await context();
		try {
			let ownership = await value.storage.channels.claimAgentOwner(
				value.channelId,
				value.sessionId,
				value.now,
			);
			let binding = await value.bindings.resolve(value.channelId);
			expect(binding).toBeDefined();
			expect(
				await value.storage.channels.clearAgentOwner(
					value.channelId,
					value.sessionId,
					ownership.generation,
					value.now,
				),
			).toBe(true);
			expect(await binding!.revalidate()).toBe(false);
			value.bindings.revokeChannel(value.channelId);
			expect(binding!.signal.aborted).toBe(true);
		} finally {
			await value.storage.close();
		}
	});

	it("refuses repository identity or role changes", async () => {
		for (let options of [{ repositoryId: "R_other" }, { push: false }]) {
			let value = await context(options);
			try {
				await value.storage.channels.claimAgentOwner(
					value.channelId,
					value.sessionId,
					value.now,
				);
				expect(await value.bindings.resolve(value.channelId)).toBeUndefined();
			} finally {
				await value.storage.close();
			}
		}
	});

	it("revokes all bindings for a logged-out session", async () => {
		let value = await context();
		try {
			await value.storage.channels.claimAgentOwner(
				value.channelId,
				value.sessionId,
				value.now,
			);
			let binding = await value.bindings.resolve(value.channelId);
			value.bindings.revokeSession(value.sessionId);
			expect(binding!.signal.aborted).toBe(true);
			expect(await value.bindings.resolve(value.channelId)).toBeUndefined();
		} finally {
			await value.storage.close();
		}
	});
});
