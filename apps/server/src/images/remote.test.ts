import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import net from "node:net";
import { Duplex } from "node:stream";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { GitHubError } from "../github/client";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { MAX_IMAGE_BYTES } from "./format";
import { imageSources, isPublicAddress, registerRemoteImageRoutes } from "./remote";
import { registerImageRoutes } from "./routes";

import type { Server } from "bun";
import type { HostedAuth } from "../auth/routes";
import type {
	GitHub,
	GitHubTokenGrant,
	GitHubUser,
	InstallationPage,
	Repository,
	RepositoryPage,
} from "../github/client";
import type { RemoteNetwork, RemoteTarget } from "./remote";

const fixture = (name: string) =>
	new Uint8Array(readFileSync(new URL(`../../../../e2e/fixtures/${name}`, import.meta.url)));

const PNG = fixture("raster-18x6.png");
const WEBP = fixture("raster-18x6.webp");
const SVG = new TextEncoder().encode(
	'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>',
);
const HTML = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
const HUGE = new Uint8Array(MAX_IMAGE_BYTES + 1);
HUGE.set(PNG);
const SLOW = HUGE.slice(0, MAX_IMAGE_BYTES);

const PUBLIC = "93.184.215.14";

class FakeGitHub implements GitHub {
	access = new Map<string, Repository["permissions"] | null>();
	ids = new Map<string, string>();

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

type Seen = {
	path: string;
	host: string | null;
	cookie: string | null;
	authorization: string | null;
};

let host: Server<undefined>;
let seen: Seen[] = [];

function image(body: Uint8Array<ArrayBuffer>, type: string): Response {
	return new Response(body, { headers: { "content-type": type } });
}

function trickle(body: Uint8Array): Duplex {
	let bytes = Buffer.from(body.buffer, body.byteOffset, body.length);
	let socket: Duplex = new Duplex({
		read() {},
		write(_chunk, _encoding, done) {
			done();
			socket.push(`HTTP/1.1 200 OK\r\ncontent-length: ${bytes.length}\r\n\r\n`);
			let sent = 0;
			let next = () => {
				if (socket.destroyed) return;
				for (let end = Math.min(sent + 20_000, bytes.length); sent < end; sent++) {
					socket.push(bytes.subarray(sent, sent + 1));
				}
				if (sent < bytes.length) setImmediate(next);
			};
			setImmediate(next);
		},
	});
	return socket;
}

function redirect(location: string): Response {
	return new Response(null, { status: 302, headers: { location } });
}

beforeAll(() => {
	host = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			let path = new URL(request.url).pathname;
			seen.push({
				path,
				host: request.headers.get("host"),
				cookie: request.headers.get("cookie"),
				authorization: request.headers.get("authorization"),
			});
			switch (path) {
				case "/wide.png":
					return image(PNG, "image/png");
				case "/named-wrong":
					return image(WEBP, "text/plain");
				case "/streamed.png":
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(PNG.slice(0, 10));
								controller.enqueue(PNG.slice(10));
								controller.close();
							},
						}),
						{ headers: { "content-type": "image/png" } },
					);
				case "/drawing.svg":
					return image(SVG, "image/svg+xml");
				case "/page.html":
					return image(HTML, "text/html");
				case "/huge.png":
					return image(HUGE, "image/png");
				case "/to-loopback":
					return redirect(`http://127.0.0.1:${server.port}/wide.png`);
				case "/to-inside":
					return redirect("http://inside.example/wide.png");
				case "/to-wide":
					return redirect("/wide.png");
				case "/around":
					return redirect("/around");
				default:
					return new Response("not here", { status: 404 });
			}
		},
	});
});

afterAll(() => {
	host.stop(true);
});

function network(): { dialed: RemoteTarget[]; network: RemoteNetwork } {
	let dialed: RemoteTarget[] = [];
	let names: Record<string, string[]> = {
		"pictures.example": [PUBLIC],
		"inside.example": ["10.0.0.7"],
		"loopback.example": ["127.0.0.1"],
		"mixed.example": [PUBLIC, "192.168.1.2"],
		"slow.example": [PUBLIC],
	};
	return {
		dialed,
		network: {
			async lookup(hostname) {
				return names[hostname] ?? [];
			},
			connect(target) {
				dialed.push(target);
				if (target.host === "slow.example") return trickle(SLOW);
				return net.connect({ host: "127.0.0.1", port: host.port! });
			},
		},
	};
}

async function setup(...messages: string[]) {
	seen = [];
	let now = new Date("2026-11-10T12:00:00.000Z");
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
	let { dialed, network: fake } = network();
	let router = new Router();
	registerImageRoutes(router, auth);
	registerRemoteImageRoutes(router, auth, fake);

	async function document(repository: string, texts: string[]) {
		return storage.channels.create({
			id: crypto.randomUUID(),
			repositoryId: `R_${repository}`,
			repositoryOwner: "octo-org",
			repositoryName: repository,
			title: `Plan for ${repository}`,
			createdBy: "U_octocat",
			now,
			initial: {
				generation: crypto.randomUUID(),
				epoch: crypto.randomUUID(),
				source: "# Plan\n",
				sourceHash: "sha256:plan",
				document: new Uint8Array(),
				sidecar: {
					version: 1,
					revision: 0,
					documentSeq: 0,
					questions: [],
					openQuestions: [],
					threads: [],
					transcript: texts.map((text, index) => ({
						id: `m${index}`,
						author: { kind: "member", handle: "ana" },
						text,
						ts: 1_700_000_000_000 + index,
					})),
				},
			},
		});
	}

	let channel = await document("score", messages);
	github.access.set("score", { pull: true, push: false, admin: false });
	let cookie = issued.cookie.split(";", 1)[0]!;
	let ask = (address: string, options: { document?: string; cookie?: string | null } = {}) => {
		let query = new URLSearchParams({ document: options.document ?? channel.id, url: address });
		let sent = options.cookie === undefined ? cookie : options.cookie;
		return router.handle(
			new Request(`https://chopin.test/images/remote?${query}`, {
				headers: sent ? { cookie: sent } : undefined,
			}),
		);
	};
	return { ask, channel, cookie, dialed, document, github, router, storage };
}

async function expectNotFound(response: Response | undefined) {
	expect(response?.status).toBe(404);
	expect(response?.headers.get("cache-control")).toBe("no-store");
	expect(await response?.text()).toBe("image not found");
}

describe("reading an image from another site for a reader", () => {
	it("reads an image the document's Chat draws, for its reader, as the raster type its bytes are", async () => {
		let { ask, dialed } = await setup(
			"![wide](http://pictures.example/wide.png) and ![named](http://pictures.example/named-wrong)",
			"![streamed](http://pictures.example/streamed.png)",
		);

		let response = await ask("http://pictures.example/wide.png");
		expect(response?.status).toBe(200);
		expect(new Uint8Array(await response!.arrayBuffer())).toEqual(PNG);
		expect(Object.fromEntries(response!.headers)).toMatchObject({
			"content-type": "image/png",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
		});
		let named = await ask("http://pictures.example/named-wrong");
		expect(named?.headers.get("content-type")).toBe("image/webp");
		expect(new Uint8Array(await named!.arrayBuffer())).toEqual(WEBP);
		let streamed = await ask("http://pictures.example/streamed.png");
		expect(new Uint8Array(await streamed!.arrayBuffer())).toEqual(PNG);

		expect(dialed).toEqual(
			Array(3).fill({ address: PUBLIC, host: "pictures.example", port: 80, secure: false }),
		);
		expect(seen.map(({ path }) => path)).toEqual(["/wide.png", "/named-wrong", "/streamed.png"]);
		for (let request of seen) {
			expect(request.host).toBe("pictures.example");
			expect(request.cookie).toBeNull();
			expect(request.authorization).toBeNull();
		}
	});

	it("answers anyone who cannot read the document as it answers a missing image, and asks no host", async () => {
		let { ask, channel, dialed, github } = await setup("![wide](http://pictures.example/wide.png)");
		let address = "http://pictures.example/wide.png";

		await expectNotFound(await ask(address, { cookie: null }));
		await expectNotFound(await ask(address, { document: crypto.randomUUID() }));
		github.access.set("score", { pull: false, push: false, admin: false });
		await expectNotFound(await ask(address));
		github.access.delete("score");
		await expectNotFound(await ask(address));
		github.access.set("score", { pull: true, push: true, admin: true });
		github.ids.set("score", "R_replaced");
		await expectNotFound(await ask(address));
		expect(dialed).toEqual([]);
		expect(seen).toEqual([]);

		github.ids.clear();
		github.access.set("score", null);
		let unavailable = await ask(address);
		expect(unavailable?.status).toBe(503);
		expect(dialed).toEqual([]);

		github.access.set("score", { pull: true, push: false, admin: false });
		expect((await ask(address, { document: channel.id }))?.status).toBe(200);
	});

	it("reads only an address the document's own Chat draws as an image", async () => {
		let { ask, dialed, document, github } = await setup(
			"[only a link](http://pictures.example/to-wide)",
			"![by reference][wide]\n\n[wide]: <http://pictures.example/wide.png>",
			"![with a space](<http://pictures.example/wide.png?size=a b>)",
		);
		let elsewhere = await document("other", ["![there](http://pictures.example/named-wrong)"]);
		github.access.set("other", { pull: true, push: false, admin: false });

		await expectNotFound(await ask("http://pictures.example/to-wide"));
		await expectNotFound(await ask("http://pictures.example/named-wrong"));
		await expectNotFound(await ask("http://pictures.example/never-written.png"));
		expect(dialed).toEqual([]);

		expect((await ask("http://pictures.example/wide.png"))?.status).toBe(200);
		expect((await ask("http://pictures.example/wide.png?size=a%20b"))?.status).toBe(200);
		expect(
			(await ask("http://pictures.example/named-wrong", { document: elsewhere.id }))?.status,
		).toBe(200);
		for (let refused of ["", "not an address", "data:image/png;base64,AAAA", "ftp://a/b.png"]) {
			await expectNotFound(await ask(refused));
		}
	});

	it("never connects to an address off the public internet, written or reached by a redirect", async () => {
		let at = host.port;
		let written = [
			`http://127.0.0.1:${at}/wide.png`,
			`http://[::1]:${at}/wide.png`,
			`http://[::ffff:127.0.0.1]:${at}/wide.png`,
			`http://2130706433:${at}/wide.png`,
			`http://0x7f.1:${at}/wide.png`,
			"http://169.254.169.254/latest/meta-data/",
			"http://10.1.2.3/wide.png",
			"http://[fd00::1]/wide.png",
			"http://inside.example/wide.png",
			"http://loopback.example/wide.png",
			"http://mixed.example/wide.png",
			"http://unknown.example/wide.png",
			"http://pictures.example/to-loopback",
			"http://pictures.example/to-inside",
		];
		let { ask, dialed } = await setup(written.map(address => `![x](${address})`).join("\n\n"));

		for (let address of written) await expectNotFound(await ask(address));
		expect(dialed.map(({ address }) => address)).toEqual([PUBLIC, PUBLIC]);
		expect(seen.map(({ path }) => path)).toEqual(["/to-loopback", "/to-inside"]);
	});

	it("follows a few redirects between public addresses, and no more", async () => {
		let { ask, dialed } = await setup(
			"![moved](http://pictures.example/to-wide) ![circling](http://pictures.example/around)",
		);

		let moved = await ask("http://pictures.example/to-wide");
		expect(moved?.status).toBe(200);
		expect(new Uint8Array(await moved!.arrayBuffer())).toEqual(PNG);
		expect(seen.map(({ path }) => path)).toEqual(["/to-wide", "/wide.png"]);
		seen = [];
		dialed.length = 0;
		await expectNotFound(await ask("http://pictures.example/around"));
		expect(dialed).toHaveLength(4);
	});

	it("is its own route beside the document's uploads, and reads what the Chat says once it is saved", async () => {
		let { ask, channel, cookie, router, storage } = await setup("Nothing drawn yet.");
		let sha256 = new Bun.CryptoHasher("sha256").update(PNG).digest("hex");
		await storage.images.put({
			channelId: channel.id,
			sha256,
			mimeType: "image/png",
			bytes: PNG,
			uploadedBy: "U_octocat",
			now: new Date(),
		});

		let upload = await router.handle(
			new Request(`https://chopin.test/images/${sha256}.png?document=${channel.id}`, {
				headers: { cookie },
			}),
		);
		expect(upload?.status).toBe(200);
		expect(upload?.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		await expectNotFound(await ask("http://pictures.example/wide.png"));
		expect(seen).toEqual([]);

		let lease = await storage.leases.acquire("chopin:writer", "remote-image-test", 30_000);
		let stored = await storage.collaboration.load(channel.id, new Date());
		await storage.collaboration.commit({
			channelId: channel.id,
			lease: lease!,
			expectedRevision: stored!.channel.revision,
			operationId: crypto.randomUUID(),
			epoch: stored!.snapshot!.epoch,
			sidecar: {
				...(stored!.sidecar as Record<string, unknown>),
				transcript: [{
					id: "later",
					author: { kind: "member", handle: "ana" },
					text: "Now ![wide](http://pictures.example/wide.png)",
					ts: 1_700_000_100_000,
				}],
			} as never,
			events: [],
			now: new Date(),
		});

		let read = await ask("http://pictures.example/wide.png");
		expect(read?.status).toBe(200);
		expect(read?.headers.get("content-type")).toBe("image/png");
	});

	it("serves no SVG, page, failed answer or image larger than an upload may be", async () => {
		let paths = ["/drawing.svg", "/page.html", "/huge.png", "/missing.png"];
		let { ask } = await setup(
			paths.map(path => `![x](http://pictures.example${path})`).join(" "),
		);

		for (let path of paths) await expectNotFound(await ask(`http://pictures.example${path}`));
		expect(seen.map(({ path }) => path)).toEqual(paths);
	});

	it("reads an image of the largest size from a host that sends it a byte at a time", async () => {
		let { ask } = await setup("![slow](http://slow.example/slow.png)");

		let response = await ask("http://slow.example/slow.png");

		expect(response?.status).toBe(200);
		expect(Buffer.from(await response!.arrayBuffer()).equals(SLOW)).toBe(true);
	}, 40_000);
});

describe("the addresses a reader may have read", () => {
	it("are public internet addresses only", () => {
		for (
			let address of [
				"93.184.215.14",
				"8.8.8.8",
				"1.1.1.1",
				"2606:4700:4700::1111",
				"2a00:1450:4001:82a::200e",
				"::ffff:93.184.215.14",
			]
		) expect(isPublicAddress(address), address).toBe(true);
		for (
			let address of [
				"0.0.0.0",
				"10.0.0.1",
				"100.64.0.1",
				"127.0.0.1",
				"127.255.255.254",
				"169.254.169.254",
				"172.16.0.1",
				"172.31.255.255",
				"192.0.0.8",
				"192.0.2.1",
				"192.88.99.1",
				"192.168.1.1",
				"198.18.0.1",
				"198.51.100.1",
				"203.0.113.1",
				"168.63.129.16",
				"224.0.0.1",
				"239.255.255.250",
				"240.0.0.1",
				"255.255.255.255",
				"::",
				"::1",
				"::ffff:127.0.0.1",
				"::ffff:7f00:1",
				"::ffff:10.0.0.1",
				"64:ff9b::7f00:1",
				"100::1",
				"2001::1",
				"2001:db8::1",
				"2002:7f00:1::1",
				"fc00::1",
				"fd12:3456::1",
				"fe80::1",
				"fe80::1%eth0",
				"fec0::1",
				"ff02::1",
				"3fff::1",
				"localhost",
				"",
			]
		) expect(isPublicAddress(address), address).toBe(false);
	});

	it("are the image sources Chat's Markdown gives the page, as it gives them", () => {
		expect(
			imageSources(
				[
					"![a](https://a.example/one.png) [b](https://a.example/link.png)",
					'![a *b* [c]](https://a.example/two.png "title")',
					"![](<https://a.example/three space.png>)",
					"![x](https://a.example/(four).png)",
					"\\![escaped](https://a.example/no.png)",
					"![relative](/icons/icon-192.png) ![data](data:image/png;base64,AAAA)",
					"![ref][Five] ![six] ![seven][] ![none][missing]",
					"[five]: https://a.example/five.png",
					"  [SIX]:\n  <https://a.example/six.png>",
					"[seven]: /seven.png",
					"[five]: https://a.example/second-five.png",
					"![amp](https://a.example/x.png?a=1&amp;b=2\\_c)",
					"![é](https://a.example/é.png)",
					"`![code](https://a.example/code.png)`",
					"    ![indented](https://a.example/indented.png)",
				].join("\n\n"),
			),
		).toEqual([
			"https://a.example/one.png",
			"https://a.example/two.png",
			"https://a.example/three%20space.png",
			"https://a.example/(four).png",
			"/icons/icon-192.png",
			"data:image/png;base64,AAAA",
			"https://a.example/five.png",
			"https://a.example/six.png",
			"/seven.png",
			"https://a.example/x.png?a=1&b=2_c",
			"https://a.example/%C3%A9.png",
		]);
	});
});
