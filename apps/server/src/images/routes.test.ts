import { Machines } from "../auth/machines";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { ulid } from "@chopin/dialect";

import { create, translate } from "../chat/service";

import { Admission } from "../auth/admission";
import { Sessions } from "../auth/session";
import { GitHubError } from "../github/client";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerImageRoutes } from "./routes";

import type { TextStreamPart, ToolSet } from "ai";
import type { HostedAuth } from "../auth/routes";
import type { Room } from "../chat/service";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

/** Repository access through the GitHub App installation, by repository name. */
class FakeGitHub implements GitHub {
	access = new Map<string, Repository["permissions"]>();
	ids = new Map<string, string>();
	checked: string[] = [];

	authorize(): string {
		return "https://github.test/authorize";
	}

	async exchange(): Promise<GitHubTokenGrant> {
		return grant("ghu_user");
	}

	async refresh(): Promise<GitHubTokenGrant> {
		return grant("ghu_refreshed");
	}

	async user(): Promise<GitHubUser> {
		return { id: "U_octocat", login: "octocat", avatarUrl: "avatar" };
	}

	async organizationMembership() {
		return undefined;
	}

	async installations(): Promise<InstallationPage> {
		return { installations: [], nextPage: undefined };
	}

	async installationRepositories(): Promise<RepositoryPage> {
		return { repositories: [], nextPage: undefined };
	}

	async repository(): Promise<Repository> {
		throw new Error("image reads use installation-gated repository access");
	}

	async repositoryAccess(
		_token: string,
		owner: string,
		name: string,
	): Promise<Repository | undefined> {
		this.checked.push(name);
		let permissions = this.access.get(name);
		if (permissions === null) throw new GitHubError("slow down", 503);
		if (!permissions) return undefined;
		return {
			id: this.ids.get(name) ?? `R_${name}`,
			owner,
			name,
			fullName: `${owner}/${name}`,
			private: true,
			url: "",
			defaultBranch: "main",
			permissions,
		};
	}

	invalidate(): void {}
}

function grant(accessToken: string): GitHubTokenGrant {
	return {
		accessToken,
		accessExpiresIn: 28_800,
		refreshToken: "ghr_user",
		refreshExpiresIn: 15_897_600,
	};
}

async function setup() {
	let now = new Date("2026-10-09T12:00:00.000Z");
	let storage = new MemoryStorage();
	await storage.users.put({ id: "U_octocat", login: "octocat", avatarUrl: "avatar", now });
	let sessions = new Sessions(storage, true, () => now);
	let issued = await sessions.issue("U_octocat", grant("ghu_user"));
	let github = new FakeGitHub();
	let config = {
		origin: "https://chopin.test",
		appSlug: "chopin-test",
		clientId: "client-id",
		clientSecret: "client-secret",
		encryptionKey: new Uint8Array(32).fill(5),
	};
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
	let router = new Router();
	registerImageRoutes(router, auth);
	let sha256 = new Bun.CryptoHasher("sha256").update(PNG).digest("hex");

	async function upload(repository: string) {
		let channel = await storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: `R_${repository}`,
			repositoryOwner: "octo-org",
			repositoryName: repository,
			title: `Plan for ${repository}`,
			createdBy: "U_octocat",
			now,
		});
		await storage.images.put({
			channelId: channel.id,
			sha256,
			mimeType: "image/png",
			bytes: PNG,
			uploadedBy: "U_octocat",
			now,
		});
		return channel;
	}

	return { router, github, storage, upload, sha256, cookie: issued.cookie.split(";", 1)[0]! };
}

function get(path: string, cookie?: string): Request {
	return new Request(`https://chopin.test${path}`, {
		headers: cookie ? { cookie } : undefined,
	});
}

async function expectNotFound(response: Response | undefined) {
	expect(response?.status).toBe(404);
	expect(response?.headers.get("cache-control")).toBe("no-store");
	expect(await response?.text()).toBe("image not found");
}

describe("hosted image routes", () => {
	it("serves an image to a reader of its document with locked-down headers", async () => {
		let { router, github, upload, sha256, cookie } = await setup();
		await upload("score");
		github.access.set("score", { pull: true, push: false, admin: false });

		let response = await router.handle(get(`/images/${sha256}.png`, cookie));
		expect(response?.status).toBe(200);
		expect(new Uint8Array(await response!.arrayBuffer())).toEqual(PNG);
		expect(Object.fromEntries(response!.headers)).toMatchObject({
			"content-type": "image/png",
			"x-content-type-options": "nosniff",
			"cache-control": "private, max-age=31536000, immutable",
			"content-security-policy": "default-src 'none'; sandbox",
			"content-disposition": "inline",
		});
	});

	it("serves the image through any readable document it was uploaded to", async () => {
		let { router, github, upload, sha256, cookie } = await setup();
		await upload("hidden");
		await upload("score");
		github.access.set("score", { pull: true, push: false, admin: false });

		let response = await router.handle(get(`/images/${sha256}.png`, cookie));
		expect(response?.status).toBe(200);
		expect(github.checked).toEqual(["hidden", "score"]);
	});

	it("answers a non-reader, a stranger and an unknown hash identically", async () => {
		let { router, github, upload, sha256, cookie } = await setup();
		await upload("score");

		await expectNotFound(await router.handle(get(`/images/${sha256}.png`)));
		await expectNotFound(await router.handle(get(`/images/${sha256}.png`, cookie)));
		github.access.set("score", { pull: false, push: false, admin: false });
		await expectNotFound(await router.handle(get(`/images/${sha256}.png`, cookie)));
		github.access.set("score", { pull: true, push: true, admin: true });
		github.ids.set("score", "R_replaced");
		await expectNotFound(await router.handle(get(`/images/${sha256}.png`, cookie)));

		github.ids.clear();
		await expectNotFound(await router.handle(get(`/images/${"0".repeat(64)}.png`, cookie)));
		expect((await router.handle(get(`/images/${sha256}.png`, cookie)))?.status).toBe(200);
	});

	it("serves a document-scoped request only from that document's own uploads", async () => {
		let { router, github, upload, sha256, cookie } = await setup();
		let own = await upload("score");
		let other = await upload("other");
		github.access.set("score", { pull: true, push: false, admin: false });
		github.access.set("other", { pull: true, push: false, admin: false });

		let scoped = await router.handle(get(`/images/${sha256}.png?document=${own.id}`, cookie));
		expect(scoped?.status).toBe(200);
		expect(github.checked).toEqual(["score"]);
		// Readable, but the card asking is in a document that never uploaded it.
		let foreign = crypto.randomUUID();
		await expectNotFound(
			await router.handle(get(`/images/${sha256}.png?document=${foreign}`, cookie)),
		);
		github.access.delete("score");
		await expectNotFound(
			await router.handle(get(`/images/${sha256}.png?document=${own.id}`, cookie)),
		);
		expect((await router.handle(get(`/images/${sha256}.png?document=${other.id}`, cookie)))?.status)
			.toBe(200);
	});

	it("refuses an extension that does not match the stored type or a malformed name", async () => {
		let { router, github, upload, sha256, cookie } = await setup();
		await upload("score");
		github.access.set("score", { pull: true, push: false, admin: false });

		for (let extension of ["jpg", "jpeg", "gif", "webp", "svg", "PNG"]) {
			await expectNotFound(await router.handle(get(`/images/${sha256}.${extension}`, cookie)));
		}
		await expectNotFound(
			await router.handle(get(`/images/${sha256.toUpperCase()}.png`, cookie)),
		);
		await expectNotFound(await router.handle(get(`/images/${sha256}`, cookie)));
	});

	it("serves a JPEG under both of its extensions", async () => {
		let { router, github, storage, upload, cookie } = await setup();
		let channel = await upload("score");
		github.access.set("score", { pull: true, push: false, admin: false });
		let jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
		let hash = new Bun.CryptoHasher("sha256").update(jpeg).digest("hex");
		await storage.images.put({
			channelId: channel.id,
			sha256: hash,
			mimeType: "image/jpeg",
			bytes: jpeg,
			uploadedBy: "U_octocat",
			now: new Date(),
		});
		for (let extension of ["jpg", "jpeg"]) {
			let response = await router.handle(get(`/images/${hash}.${extension}`, cookie));
			expect(response?.headers.get("content-type")).toBe("image/jpeg");
		}
	});

	it("serves an image a Planner turn made only to the document's readers, as its own type", async () => {
		let { router, github, storage, upload, cookie } = await setup();
		let channel = await upload("score");
		let picture = new Uint8Array(
			readFileSync(new URL("../../../../e2e/fixtures/the-cap.webp", import.meta.url)),
		);
		let chat = create();
		chat.agent = { activeTools: ["codemode"] } as never;
		chat.busy = true;
		chat.turnController = new AbortController();
		let entryId = ulid();
		chat.entries.push({
			id: entryId,
			author: { kind: "member", handle: "octocat" },
			text: "Draw the cap",
			ts: 1,
		});
		chat.turn = {
			id: "turn-1",
			handle: "octocat",
			started: 1,
			startedAt: 1,
			entryOffset: 1,
			responded: false,
		};
		chat.activeRequest = {
			entryId,
			userId: "U_octocat",
			handle: "octocat",
			text: "Draw the cap",
			claimantSessionId: undefined,
			turnId: "turn-1",
			lifecycle: chat.lifecycle,
		};
		let context = {
			chat,
			server: { publish() {} },
			room: channel.id,
			plan: {},
			config: {},
			auth: { clock: () => new Date(), storage },
		} as unknown as Room;
		let send = (value: Record<string, unknown>) =>
			translate(context, value as TextStreamPart<ToolSet>);
		send({ type: "tool-call", toolCallId: "c1", toolName: "codemode", input: {} });
		send({
			type: "tool-result",
			toolCallId: "c1",
			toolName: "codemode",
			input: {},
			output: {
				content: [{
					type: "image",
					data: Buffer.from(picture).toString("base64"),
					mimeType: "image/webp",
					alt: "The cap is a balance of 100.",
				}],
			},
		});
		await chat.turnImages?.work;
		let [image] = chat.entries.flatMap(entry => entry.images ?? []);
		expect(image).toMatchObject({ width: 1536, height: 1024, generated: true });
		let path = `${image!.src}?document=${channel.id}`;

		github.access.set("score", { pull: true, push: false, admin: false });
		let response = await router.handle(get(path, cookie));
		expect(response?.status).toBe(200);
		expect(new Uint8Array(await response!.arrayBuffer())).toEqual(picture);
		expect(Object.fromEntries(response!.headers)).toMatchObject({
			"content-type": "image/webp",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
		});
		await expectNotFound(await router.handle(get(path)));
		await expectNotFound(await router.handle(get(image!.src.replace(".webp", ".png"), cookie)));
		github.access.set("score", { pull: false, push: false, admin: false });
		await expectNotFound(await router.handle(get(path, cookie)));
	});

	it("reports an unavailable GitHub rather than a missing image", async () => {
		let { router, github, upload, sha256, cookie } = await setup();
		await upload("score");
		github.access.set("score", null as unknown as Repository["permissions"]);

		let response = await router.handle(get(`/images/${sha256}.png`, cookie));
		expect(response?.status).toBe(503);
		expect(response?.headers.get("cache-control")).toBe("no-store");
	});
});
