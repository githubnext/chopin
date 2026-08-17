import { describe, expect, it } from "bun:test";

import { ulid } from "@chopin/dialect";

import { Sessions } from "../auth/session";
import { GitHubError } from "../github/client";
import * as Room from "../plan/room";
import * as Service from "../plan/service";
import * as Rooms from "../rooms";
import { MemoryStorage } from "../storage/memory/adapter";
import { hosted } from "./hosted";

import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubUser, Repository, RepositoryPage } from "../github/client";
import type { Socket, SocketData } from "../wire";

class GitHubBoundary implements GitHub {
	readonly userTokens: string[] = [];
	accessible = true;
	repositoryValue: Repository = {
		id: "R_score",
		owner: "octo-org",
		name: "score",
		fullName: "octo-org/score",
		private: true,
		url: "https://github.test/octo-org/score",
		defaultBranch: "main",
		permissions: { pull: true, push: false, admin: false },
	};

	authorize(): string {
		return "";
	}

	async exchange(): Promise<string> {
		return "";
	}

	async user(token: string): Promise<GitHubUser> {
		this.userTokens.push(token);
		if (token === "denied") throw new GitHubError("bad credentials", 401);
		return { id: `U_${token}`, login: token, avatarUrl: "https://github.test/avatar" };
	}

	async repositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}

	async repository(_token: string, owner: string, name: string): Promise<Repository> {
		return this.value(owner, name);
	}

	async repositoryAccess(
		_token: string,
		owner: string,
		name: string,
	): Promise<Repository | undefined> {
		return this.accessible ? this.value(owner, name) : undefined;
	}

	private value(owner: string, name: string): Repository {
		return {
			...this.repositoryValue,
			owner,
			name,
			fullName: `${owner}/${name}`,
			url: `https://github.test/${owner}/${name}`,
		};
	}
}

function setup() {
	let now = new Date("2026-08-17T12:00:00.000Z");
	let storage = new MemoryStorage();
	let github = new GitHubBoundary();
	let key = new Uint8Array(32).fill(3);
	let auth: HostedAuth = {
		config: {
			origin: "https://chopin.test",
			clientId: "client-id",
			clientSecret: "client-secret",
			encryptionKey: key,
		},
		storage,
		github,
		sessions: new Sessions(storage, key, true, () => now),
		clock: () => now,
	};
	return { auth, github, now, storage };
}

function request(authorization?: string | Headers): Request {
	let headers = authorization instanceof Headers
		? authorization
		: authorization
		? new Headers({ authorization })
		: undefined;
	return new Request("https://chopin.test/mcp", { headers });
}

async function plan(context: ReturnType<typeof setup>) {
	await context.storage.users.put({
		id: "U_allowed",
		login: "allowed",
		avatarUrl: "",
		now: context.now,
	});
	let channel = await context.storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release readiness",
		createdBy: "U_allowed",
		now: context.now,
	});
	let lease = await context.storage.leases.acquire("writer", "mcp-test", 60_000);
	if (!lease) throw new Error("could not acquire test lease");
	let server = { publish() {} } as unknown as Server<SocketData>;
	let backend: Service.Backend = {
		storage: context.storage,
		lease: () => lease,
		fatal: err => {
			throw err;
		},
	};
	return { channel, lease, server, plan: await Service.open(channel.id, backend, server) };
}

describe("the hosted MCP adapter", () => {
	it("accepts exactly one bearer token and validates its GitHub identity per request", async () => {
		let { auth, github } = setup();
		let adapter = hosted(auth);
		let duplicate = new Headers();
		duplicate.append("authorization", "Bearer first");
		duplicate.append("authorization", "Bearer second");

		expect(await adapter.caller(request())).toBeUndefined();
		expect(await adapter.caller(request("Basic token"))).toBeUndefined();
		expect(await adapter.caller(request(duplicate))).toBeUndefined();
		expect(await adapter.caller(request("Bearer denied"))).toBeUndefined();
		expect(await adapter.caller(request("Bearer allowed"))).toEqual({
			oauthToken: "allowed",
			user: {
				id: "U_allowed",
				login: "allowed",
				avatarUrl: "https://github.test/avatar",
			},
		});
		expect(await adapter.caller(request("bearer allowed"))).toBeDefined();
		expect(await adapter.caller(request("Bearer token+/=="))).toBeDefined();
		expect(github.userTokens).toEqual(["denied", "allowed", "allowed", "token+/=="]);
	});

	it("lists every channel under the currently readable repository node id", async () => {
		let { auth, github, now, storage } = setup();
		await storage.users.put({ id: "U_allowed", login: "allowed", avatarUrl: "", now });
		for (let index = 0; index < 101; index++) {
			await storage.channels.create({
				id: crypto.randomUUID(),
				repositoryId: "R_score",
				repositoryOwner: "octo-org",
				repositoryName: "score",
				title: `Plan ${String(index).padStart(3, "0")}`,
				createdBy: "U_allowed",
				now,
			});
		}
		await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: "R_foreign",
			repositoryOwner: "elsewhere",
			repositoryName: "private",
			title: "Foreign title",
			createdBy: "U_allowed",
			now,
		});
		let adapter = hosted(auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");

		let listed = await adapter.documents.list(caller, "octo-org/score");
		expect(listed).toHaveLength(101);
		expect(listed.map(document => document.title)).not.toContain("Foreign title");

		github.repositoryValue = {
			...github.repositoryValue,
			permissions: { pull: false, push: true, admin: false },
		};
		expect(await adapter.documents.list(caller, "octo-org/score")).toEqual([]);
		github.accessible = false;
		expect(await adapter.documents.list(caller, "octo-org/score")).toEqual([]);
	});

	it("reconstructs a stored checkpoint and journal with the validated plan revision", async () => {
		let context = setup();
		let opened = await plan(context);
		let mutation = Room.insertDecision(opened.plan.document, {
			id: ulid(),
			quote: "Ship the release",
			by: "allowed",
			at: "2026-08-17T12:00:00.000Z",
			notes: [{ by: "allowed", text: "The checks are green" }],
		});
		if (!mutation) throw new Error("test mutation was empty");
		await Service.publish(opened.plan, opened.server, opened.channel.id, mutation);
		let stored = await context.storage.collaboration.load(opened.channel.id, context.now);
		expect(stored?.updates).toHaveLength(1);
		let expectedSource = Service.source(opened.plan);
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");

		expect(await adapter.documents.read(caller, opened.channel.id)).toEqual({
			id: opened.channel.id,
			title: "Release readiness",
			source: expectedSource,
			revision: 1,
		});
		await Service.close(opened.plan);
	});

	it("reads an open plan from its authoritative live document", async () => {
		let context = setup();
		let opened = await plan(context);
		let mutation = Room.insertDecision(opened.plan.document, {
			id: ulid(),
			quote: "Live and not checkpointed",
			by: "allowed",
			at: "2026-08-17T12:00:00.000Z",
			notes: [{ by: "allowed", text: "Read the live document" }],
		});
		if (!mutation) throw new Error("test mutation was empty");
		opened.plan.revision = 9;
		let socket = {
			data: { room: opened.channel.id, client: "mcp-test" },
		} as unknown as Socket;
		let live = Rooms.join(socket);
		live.plan = opened.plan;
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");

		try {
			expect(await adapter.documents.read(caller, opened.channel.id)).toEqual({
				id: opened.channel.id,
				title: "Release readiness",
				source: Service.source(opened.plan),
				revision: 9,
			});
		} finally {
			Rooms.forget(live);
			await Service.close(opened.plan);
		}
	});

	it("makes an inaccessible channel indistinguishable from a missing channel", async () => {
		let context = setup();
		let opened = await plan(context);
		await Service.close(opened.plan);
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");
		let missing = await adapter.documents.read(caller, crypto.randomUUID());
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			id: "R_replaced",
			permissions: { pull: true, push: true, admin: true },
		};

		expect(await adapter.documents.read(caller, opened.channel.id)).toBe(missing);
		context.github.repositoryValue = {
			...context.github.repositoryValue,
			id: "R_score",
			permissions: { pull: false, push: true, admin: true },
		};
		expect(await adapter.documents.read(caller, opened.channel.id)).toBe(missing);
		expect(missing).toBeUndefined();
	});

	it("treats malformed durable state as an absent channel", async () => {
		let context = setup();
		let opened = await plan(context);
		await Service.close(opened.plan);
		let stored = await context.storage.collaboration.load(opened.channel.id, context.now);
		if (!stored?.snapshot) throw new Error("test channel has no checkpoint");
		await context.storage.collaboration.commit({
			channelId: opened.channel.id,
			lease: opened.lease,
			expectedRevision: stored.channel.revision,
			operationId: crypto.randomUUID(),
			epoch: stored.snapshot.epoch,
			sidecar: { version: 1, revision: 40 },
			events: [],
			now: context.now,
		});
		let adapter = hosted(context.auth);
		let caller = await adapter.caller(request("Bearer allowed"));
		if (!caller) throw new Error("test caller was not authenticated");

		expect(await adapter.documents.read(caller, opened.channel.id)).toBeUndefined();
	});
});
