import { describe, expect, it } from "bun:test";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { Router } from "../http/router";
import { sourceHash } from "../plan/service";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerMentionRoutes } from "./mention-routes";
import { RepositoryFiles } from "./repository-files";

import type { MentionSources } from "@chopin/protocol/mention-sources";
import type { HostedAuth } from "../auth/routes";
import type { GitHub, Repository } from "../github/client";

const USER_ID = "MDQ6VXNlcjU0MjcwODM=";
const REPOSITORY_ID = "MDEwOlJlcG9zaXRvcnkxMjM=";
const SOURCE = [
	"# Overview",
	"",
	"## Site survey",
	"",
	'<Questionnaire id="01HQ0000000000000000000000">',
	'<Question id="q1" header="Rollout" prompt="How?" multiple="false">',
	'<Option id="o1" label="Canary" />',
	"</Question>",
	"</Questionnaire>",
	"",
	'<Research id="workspace-1" />',
	"",
].join("\n");

async function setup(options: { files?: boolean; pull?: boolean } = {}) {
	let now = new Date("2026-08-23T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: USER_ID, login: "octocat", avatarUrl: "avatar", now });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: REPOSITORY_ID,
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: USER_ID,
		now,
	});
	let repository: Repository = {
		id: REPOSITORY_ID,
		owner: "octo-org",
		name: "score",
		fullName: "octo-org/score",
		private: true,
		url: "https://github.test/octo-org/score",
		defaultBranch: "main",
		permissions: { pull: options.pull ?? true, push: true, admin: false },
	};
	let github = {
		async repositoryAccess(_token: string, owner: string, name: string) {
			return owner === "octo-org" && name === "score" ? repository : undefined;
		},
	} as unknown as GitHub;
	let config = {
		origin: "https://chopin.test",
		appSlug: "chopin-test",
		clientId: "client-id",
		clientSecret: "client-secret",
		encryptionKey: new Uint8Array(32).fill(4),
	};
	let sessions = new Sessions(storage, true, () => now);
	let issued = await sessions.issue(USER_ID, {
		accessToken: "ghu_user",
		accessExpiresIn: 28_800,
		refreshToken: "ghr_user",
		refreshExpiresIn: 15_897_600,
	});
	let auth: HostedAuth = {
		config,
		storage,
		github,
		admission: new Admission(config, github, () => now.getTime()),
		sessions,
		clock: () => now,
		machines: new Machines(storage, () => new Date(), {
			origin: "https://chopin.test",
			clientId: "test",
		}),
		pairings: {},
	};
	let listed: string[] = [];
	let router = new Router();
	registerMentionRoutes(router, auth, {
		current: async channelId => ({
			channelId,
			revision: 3,
			source: SOURCE,
			sourceHash: sourceHash(SOURCE),
		}),
		research: async () => [
			{ id: "workspace-1", title: "Release Research" },
			{ id: "workspace-unplaced", title: "Never put in the document" },
		],
		...(options.files === false ? {} : {
			files: new RepositoryFiles({
				remote: async (session, listedRepository) => {
					listed.push(
						`${session}:${listedRepository.owner}/${listedRepository.name}@${listedRepository.defaultBranch}`,
					);
					return { paths: ["README.md", "src/survey.ts", "src/index.ts"], truncated: false };
				},
			}),
		}),
	});
	return { channel, router, cookie: issued.cookie.split(";", 1)[0]!, listed };
}

async function ask(
	context: Awaited<ReturnType<typeof setup>>,
	query: string,
	cookie: string | undefined = context.cookie,
	channel: string = context.channel.id,
) {
	let headers = new Headers();
	if (cookie) headers.set("cookie", cookie);
	let response = await context.router.handle(
		new Request(`https://chopin.test/api/channels/${channel}/mentions${query}`, { headers }),
	);
	if (!response) throw new Error("the mentions route was not registered");
	return response;
}

describe("what @ can point at in a document", () => {
	it("lists its headings, Decisions, placed research cards and files, as the server later resolves them", async () => {
		let context = await setup();
		let response = await ask(context, "");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual<MentionSources>({
			headings: [
				{ anchor: "overview", text: "Overview", level: 1 },
				{ anchor: "site-survey", text: "Site survey", level: 2 },
			],
			decisions: [{ id: "01HQ0000000000000000000000", title: "Rollout" }],
			research: [{ workspaceId: "workspace-1", title: "Release Research" }],
			files: ["README.md", "src/survey.ts", "src/index.ts"],
		});
	});

	it("narrows every kind by the query and by the limit, files read as the person's own session", async () => {
		let context = await setup();
		expect(await (await ask(context, "?query=survey")).json()).toEqual({
			headings: [{ anchor: "site-survey", text: "Site survey", level: 2 }],
			decisions: [],
			research: [],
			files: ["src/survey.ts"],
		});
		let limited = await (await ask(context, "?query=&limit=1")).json() as MentionSources;
		expect(limited.headings).toHaveLength(1);
		expect(limited.files).toEqual(["README.md"]);
		expect(context.listed).toHaveLength(1);
		expect(context.listed[0]).toMatch(/^.+:octo-org\/score@main$/);
	});

	it("leaves files out where the repository's cannot be listed", async () => {
		let context = await setup({ files: false });
		let body = await (await ask(context, "")).json() as MentionSources;
		expect("files" in body).toBe(false);
		expect(body.headings).toHaveLength(2);
	});

	it("says nothing to a stranger, a person who cannot read the repository or a bad channel, and refuses a bad query", async () => {
		let context = await setup();
		expect((await ask(context, "", "")).status).toBe(401);
		expect((await ask(context, "", context.cookie, "not-a-channel")).status).toBe(404);
		expect((await ask(context, "", context.cookie, crypto.randomUUID())).status).toBe(404);
		let denied = await setup({ pull: false });
		expect((await ask(denied, "")).status).toBe(404);
		expect((await ask(context, `?query=${"x".repeat(65)}`)).status).toBe(400);
		expect((await ask(context, "?limit=0")).status).toBe(400);
		expect((await ask(context, "?limit=21")).status).toBe(400);
		expect((await ask(context, "?limit=two")).status).toBe(400);
	});
});
