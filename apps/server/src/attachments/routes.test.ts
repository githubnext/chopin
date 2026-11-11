import { describe, expect, it } from "bun:test";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { GitHubError } from "../github/client";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { registerAttachmentRoutes } from "./routes";

import type { AttachmentLimits } from "@chopin/protocol/attachment";
import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";

const ORIGIN = "https://chopin.test";
const LIMITS: AttachmentLimits = { maxBytes: 64, maxCount: 2, maxTotalBytes: 96 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
const PAGE = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

type Permissions = Repository["permissions"];
const WRITE: Permissions = { pull: true, push: true, admin: false };
const READ: Permissions = { pull: true, push: false, admin: false };

/** Repository access by the token that asks, so two people can hold different permissions. */
class FakeGitHub implements GitHub {
	access = new Map<string, Permissions | null>();
	authorize(): string {
		return "https://github.test/authorize";
	}
	async exchange(): Promise<GitHubTokenGrant> {
		return grant("ghu_octocat");
	}
	async refresh(): Promise<GitHubTokenGrant> {
		return grant("ghu_octocat");
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
		throw new Error("attachments use installation-gated repository access");
	}
	async repositoryAccess(token: string, owner: string, name: string) {
		let permissions = this.access.get(`${token}:${name}`);
		if (permissions === null) throw new GitHubError("slow down", 503);
		if (!permissions) return undefined;
		return {
			id: `R_${name}`,
			owner,
			name,
			fullName: `${owner}/${name}`,
			private: true,
			url: "",
			defaultBranch: "main",
			permissions,
		} satisfies Repository;
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

async function setup(configured: AttachmentLimits | null = LIMITS) {
	let limits = configured ?? undefined;
	let now = new Date("2026-10-09T12:00:00.000Z");
	let storage = new MemoryStorage();
	let sessions = new Sessions(storage, true, () => now);
	let github = new FakeGitHub();
	let people: Record<string, { id: string; cookie: string }> = {};
	for (let login of ["octocat", "hubot", "outsider"]) {
		let id = `U_${login}`;
		await storage.users.put({ id, login, avatarUrl: "avatar", now });
		let issued = await sessions.issue(id, grant(`ghu_${login}`));
		people[login] = { id, cookie: issued.cookie.split(";", 1)[0]! };
	}
	let config = {
		origin: ORIGIN,
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
		machines: new Machines(storage, () => new Date(), { origin: ORIGIN, clientId: "test" }),
		pairings: {},
	};
	let router = new Router();
	let counter = 0;
	registerAttachmentRoutes(router, auth, { limits, id: () => `attachment-${++counter}` });
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Release plan",
		createdBy: "U_octocat",
		now,
	});
	github.access.set("ghu_octocat:score", WRITE);
	github.access.set("ghu_hubot:score", READ);
	let path = `/api/channels/${channel.id}/attachments`;

	let upload = (
		who: string | undefined,
		body: Uint8Array | string | ReadableStream<Uint8Array>,
		query = "name=shot.png",
		headers: Record<string, string> = {},
	) =>
		router.handle(
			new Request(`${ORIGIN}${path}?${query}`, {
				method: "POST",
				body: body as BodyInit,
				headers: {
					origin: ORIGIN,
					...(who ? { cookie: people[who]!.cookie } : {}),
					...headers,
				},
				...({ duplex: "half" } as object),
			}),
		);
	let read = (who: string | undefined, id: string, to = path) =>
		router.handle(
			new Request(`${ORIGIN}${to}/${id}`, {
				headers: who ? { cookie: people[who]!.cookie } : undefined,
			}),
		);
	let send = async (id: string, entryId = "message-1", by = "octocat") => {
		expect(
			await storage.chatAttachments.bind({
				channelId: channel.id,
				userId: people[by]!.id,
				ids: [id],
				entryId,
			}),
		).toBe(true);
	};
	return { router, github, storage, channel, path, upload, read, send, people };
}

async function stored(storage: MemoryStorage, channelId: string, id: string) {
	return storage.chatAttachments.get(channelId, id);
}

describe("uploading a file to a document's Chat", () => {
	it("keeps a writer's image under the type its bytes have, and says what it kept", async () => {
		let { upload, storage, channel } = await setup();
		// The name says text, the bytes say PNG: the bytes decide.
		let response = await upload("octocat", PNG, "name=%E2%80%AEnotes.txt&type=text/plain");
		expect(response?.status).toBe(201);
		let { attachment } = await response!.json();
		expect(attachment).toEqual({
			id: "attachment-1",
			name: "notes.txt",
			kind: "image",
			mimeType: "image/png",
			size: PNG.byteLength,
		});
		let kept = await stored(storage, channel.id, "attachment-1");
		expect(kept?.uploadedBy).toBe("U_octocat");
		expect(kept?.entryId).toBeUndefined();
		expect(kept?.bytes).toEqual(PNG);
	});

	it("keeps text as plain text, whatever it is called", async () => {
		let { upload } = await setup();
		let response = await upload("octocat", "# Notes\n", "name=notes.md&type=text/markdown");
		expect((await response!.json()).attachment).toMatchObject({
			kind: "file",
			mimeType: "text/plain",
			name: "notes.md",
		});
		// A page uploaded as a text file is text: it is served as text, never as a page.
		let page = await upload("octocat", PAGE, "name=index.html&type=text/html");
		expect((await page!.json()).attachment).toMatchObject({ kind: "file", mimeType: "text/plain" });
	});

	it("refuses a page or an SVG that claims to be an image, and keeps nothing", async () => {
		let { upload, storage, channel } = await setup();
		for (
			let [bytes, query] of [[PAGE, "name=evil.png"], [PAGE, "name=x&type=image/png"], [
				SVG,
				"name=logo.svg&type=image/svg%2Bxml",
			]] as const
		) {
			let response = await upload("octocat", bytes, query);
			expect(response?.status, query).toBe(422);
			expect((await response!.json()).reason).toBe("image-type");
		}
		expect(await storage.chatAttachments.staged(channel.id, "U_octocat")).toEqual({
			count: 0,
			bytes: 0,
		});
	});

	it("refuses a binary that is not an image and an empty file", async () => {
		let { upload } = await setup();
		let zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
		let binary = await upload("octocat", zip, "name=archive.txt");
		expect(binary?.status).toBe(422);
		expect((await binary!.json()).reason).toBe("unsupported");
		let empty = await upload("octocat", new Uint8Array(), "name=empty.txt");
		expect(empty?.status).toBe(422);
		expect((await empty!.json()).reason).toBe("empty");
	});

	it("holds a file to the per-file cap at its exact edge, however it is declared", async () => {
		let { upload, storage, channel } = await setup();
		let atCap = await upload("octocat", "a".repeat(LIMITS.maxBytes), "name=cap.txt");
		expect(atCap?.status).toBe(201);
		let over = await upload("octocat", "a".repeat(LIMITS.maxBytes + 1), "name=over.txt");
		expect(over?.status).toBe(413);
		expect((await over!.json()).reason).toBe("too-large");
		// A body whose length is not declared is cut at the cap as it is read.
		let stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("a".repeat(LIMITS.maxBytes)));
				controller.enqueue(new TextEncoder().encode("a"));
				controller.close();
			},
		});
		let chunked = await upload("octocat", stream, "name=x.txt");
		expect(chunked?.status).toBe(413);
		expect(await storage.chatAttachments.staged(channel.id, "U_octocat")).toMatchObject({
			count: 1,
		});
	});

	it("bounds what one person can leave unsent", async () => {
		let { upload } = await setup({ maxBytes: 64, maxCount: 1, maxTotalBytes: 64 });
		// Four times what a message may carry, by count.
		for (let index = 0; index < 4; index++) {
			expect((await upload("octocat", `file ${index}`, `name=f${index}.txt`))?.status).toBe(201);
		}
		let more = await upload("octocat", "one more", "name=more.txt");
		expect(more?.status).toBe(429);
		expect((await more!.json()).reason).toBe("too-many");
	});

	it("refuses a reader who cannot write, a stranger, a visitor and another origin", async () => {
		let { upload, storage, channel } = await setup();
		let reader = await upload("hubot", "hi");
		expect(reader?.status).toBe(403);
		expect((await reader!.json()).reason).toBe("not-allowed");
		expect((await upload("outsider", "hi"))?.status).toBe(404);
		expect((await upload(undefined, "hi"))?.status).toBe(401);
		expect((await upload("octocat", "hi", "name=a.txt", { origin: "https://evil.test" }))?.status)
			.toBe(403);
		expect(await storage.chatAttachments.staged(channel.id, "U_octocat")).toEqual({
			count: 0,
			bytes: 0,
		});
	});

	it("refuses an archived document and an unknown one", async () => {
		let { upload, storage, channel, router, people } = await setup();
		await storage.channels.archive({ id: channel.id, now: new Date("2026-10-09T13:00:00.000Z") });
		expect((await upload("octocat", "hi"))?.status).toBe(403);
		let unknown = await router.handle(
			new Request(`${ORIGIN}/api/channels/${crypto.randomUUID()}/attachments?name=a.txt`, {
				method: "POST",
				body: "hi",
				headers: { origin: ORIGIN, cookie: people.octocat!.cookie },
			}),
		);
		expect(unknown?.status).toBe(404);
	});

	it("takes no files where the server is set to take none", async () => {
		let { upload, read } = await setup(null);
		expect((await upload("octocat", "hi"))?.status).toBe(404);
		expect((await read("octocat", "attachment-1"))?.status).toBe(404);
	});
});

describe("reading a file sent with a message", () => {
	it("shows a reader a raster image inline, under its own type, locked down", async () => {
		let { upload, read, send } = await setup();
		await upload("octocat", PNG);
		await send("attachment-1");
		let response = await read("hubot", "attachment-1");
		expect(response?.status).toBe(200);
		expect(new Uint8Array(await response!.arrayBuffer())).toEqual(PNG);
		expect(Object.fromEntries(response!.headers)).toMatchObject({
			"content-type": "image/png",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
			"cross-origin-resource-policy": "same-origin",
			"cache-control": "private, max-age=31536000, immutable",
		});
		expect(response!.headers.get("content-disposition")).toStartWith("inline;");
	});

	it("gives a text file as a download of plain text, even when it is a page", async () => {
		let { upload, read, send } = await setup();
		await upload("octocat", PAGE, "name=%22%3E%3Cb%3Eindex.html&type=text/html");
		await send("attachment-1");
		let response = await read("hubot", "attachment-1");
		expect(response?.status).toBe(200);
		expect(response!.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		let disposition = response!.headers.get("content-disposition")!;
		expect(disposition).toStartWith("attachment;");
		// Nothing of the name can end the header or start another parameter.
		expect(disposition).not.toContain('"><');
		expect(response!.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response!.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(new Uint8Array(await response!.arrayBuffer())).toEqual(PAGE);
	});

	it("never serves a stored file as HTML or SVG, whatever the name says", async () => {
		let { upload, read, send } = await setup();
		let sent = 0;
		for (
			let [bytes, name] of [[PAGE, "a.html"], [SVG, "b.svg"], [PAGE, "c.htm"], [
				SVG,
				"d.txt",
			]] as const
		) {
			let uploaded = await upload("octocat", bytes, `name=${name}`);
			// An SVG called an image is refused outright; one called text is kept as plain text.
			if (uploaded?.status !== 201) continue;
			let { attachment } = await uploaded.json();
			await send(attachment.id, `message-${sent++}`);
			let response = await read("octocat", attachment.id);
			expect(response!.headers.get("content-type"), name).toBe("text/plain; charset=utf-8");
			expect(response!.headers.get("content-disposition"), name).toStartWith("attachment;");
		}
		expect(sent).toBe(3);
	});

	it("answers a visitor, a stranger and a missing file the same way", async () => {
		let { upload, read, send, github, path } = await setup();
		await upload("octocat", PNG);
		await send("attachment-1");
		let same = async (response: Response | undefined) => {
			expect(response?.status).toBe(404);
			expect(await response?.text()).toBe("file not found");
			expect(response?.headers.get("cache-control")).toBe("no-store");
		};
		await same(await read(undefined, "attachment-1"));
		await same(await read("outsider", "attachment-1"));
		await same(await read("hubot", "attachment-missing"));
		// A reader of another document does not read it through his own.
		await same(
			await read("hubot", "attachment-1", `/api/channels/${crypto.randomUUID()}/attachments`),
		);
		// Access taken away is access gone.
		github.access.set("ghu_hubot:score", { pull: false, push: false, admin: false });
		await same(await read("hubot", "attachment-1"));
		expect(path).toContain("/attachments");
	});

	it("keeps an upload to its uploader until a message is sent with it", async () => {
		let { upload, read, send } = await setup();
		await upload("octocat", PNG);
		expect((await read("octocat", "attachment-1"))?.status).toBe(200);
		expect((await read("hubot", "attachment-1"))?.status).toBe(404);
		await send("attachment-1");
		expect((await read("hubot", "attachment-1"))?.status).toBe(200);
	});

	it("reports an unavailable GitHub rather than a missing file", async () => {
		let { upload, read, send, github } = await setup();
		await upload("octocat", PNG);
		await send("attachment-1");
		github.access.set("ghu_hubot:score", null);
		let response = await read("hubot", "attachment-1");
		expect(response?.status).toBe(503);
		expect(response?.headers.get("cache-control")).toBe("no-store");
	});
});

describe("taking an upload back", () => {
	it("lets its uploader remove it until it is sent, and nobody else, and not after", async () => {
		let { upload, router, path, people, storage, channel, send } = await setup();
		await upload("octocat", "a", "name=a.txt");
		await upload("octocat", "b", "name=b.txt");
		let remove = (who: string | undefined, id: string, origin = ORIGIN) =>
			router.handle(
				new Request(`${ORIGIN}${path}/${id}`, {
					method: "DELETE",
					headers: { origin, ...(who ? { cookie: people[who]!.cookie } : {}) },
				}),
			);
		expect((await remove("hubot", "attachment-1"))?.status).toBe(404);
		expect((await remove(undefined, "attachment-1"))?.status).toBe(401);
		expect((await remove("octocat", "attachment-1", "https://evil.test"))?.status).toBe(403);
		expect((await remove("octocat", "attachment-1"))?.status).toBe(204);
		expect(await stored(storage, channel.id, "attachment-1")).toBeUndefined();
		expect((await remove("octocat", "attachment-1"))?.status).toBe(404);
		await send("attachment-2");
		expect((await remove("octocat", "attachment-2"))?.status).toBe(404);
		expect(await stored(storage, channel.id, "attachment-2")).toBeDefined();
	});
});
