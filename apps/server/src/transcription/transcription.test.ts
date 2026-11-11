import { describe, expect, it } from "bun:test";

import { Admission } from "../auth/admission";
import { Machines } from "../auth/machines";
import { Sessions } from "../auth/session";
import { configured } from "../testing/config";
import { Router } from "../http/router";
import { MemoryStorage } from "../storage/memory/adapter";
import { audioFileName, sniffAudio } from "./audio";
import { openaiTranscriber } from "./openai";
import { registerTranscriptionRoutes } from "./routes";

import type { HostedAuth } from "../auth/routes";
import type { GitHub, GitHubTokenGrant, Repository } from "../github/client";

const ORIGIN = "https://chopin.test";
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const bytes = (text: string) => new TextEncoder().encode(text);

describe("what is audio, from its bytes", () => {
	it("knows a recording a browser makes, and a plain WAV or MP3", () => {
		expect(sniffAudio(WEBM)).toBe("audio/webm");
		expect(sniffAudio(bytes("OggS\0\u0002"))).toBe("audio/ogg");
		expect(sniffAudio(bytes("RIFF\0\0\0\0WAVEfmt "))).toBe("audio/wav");
		expect(sniffAudio(bytes("\0\0\0\u0018ftypmp42"))).toBe("audio/mp4");
		expect(sniffAudio(bytes("ID3\u0004\0"))).toBe("audio/mpeg");
		expect(sniffAudio(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg");
		expect(audioFileName("audio/webm")).toBe("dictation.webm");
	});

	it("refuses anything else, whatever it is called", () => {
		for (let other of ["<html>", "%PDF-1.7", "GIF89a", "PK\u0003\u0004", ""]) {
			expect(sniffAudio(bytes(other)), other).toBeUndefined();
		}
		expect(sniffAudio(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
	});
});

describe("OpenAI's transcription", () => {
	it("sends the recording with the operator's model and key, and gives back the words", async () => {
		let seen: { url: string; auth: string | null; model: unknown; file: File } | undefined;
		let transcribe = openaiTranscriber({
			model: "gpt-4o-mini-transcribe",
			apiKey: "sk-test",
			fetch: (async (url: string, init: RequestInit) => {
				let form = init.body as FormData;
				seen = {
					url,
					auth: new Headers(init.headers).get("authorization"),
					model: form.get("model"),
					file: form.get("file") as File,
				};
				return Response.json({ text: " hello there " });
			}) as unknown as typeof fetch,
		});
		expect(await transcribe({ bytes: WEBM, type: "audio/webm" })).toBe(" hello there ");
		expect(seen).toMatchObject({
			url: "https://api.openai.com/v1/audio/transcriptions",
			auth: "Bearer sk-test",
			model: "gpt-4o-mini-transcribe",
		});
		expect(seen!.file.name).toBe("dictation.webm");
		expect(seen!.file.type).toBe("audio/webm");
		expect(new Uint8Array(await seen!.file.arrayBuffer())).toEqual(WEBM);
	});

	it("fails with what the provider did, not with its key", async () => {
		let down = openaiTranscriber({
			model: "m",
			apiKey: "sk-secret",
			fetch: (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch,
		});
		let error = await down({ bytes: WEBM, type: "audio/webm" }).catch(value => value);
		expect(String(error)).toContain("429");
		expect(String(error)).not.toContain("sk-secret");
		let odd = openaiTranscriber({
			model: "m",
			apiKey: "k",
			fetch: (async () => Response.json({ error: "x" })) as unknown as typeof fetch,
		});
		expect(String(await odd({ bytes: WEBM, type: "audio/webm" }).catch(value => value))).toContain(
			"no text",
		);
	});
});

describe("the setting that turns it on", () => {
	it("is off unless an operator names a model, and then needs the provider's key", () => {
		expect(configured().transcription).toBeUndefined();
		expect(configured({ TRANSCRIPTION_MODEL: "off" }).transcription).toBeUndefined();
		expect(
			configured({ TRANSCRIPTION_MODEL: "openai/gpt-4o-mini-transcribe", OPENAI_API_KEY: "k" })
				.transcription,
		).toEqual({ provider: "openai", model: "gpt-4o-mini-transcribe", maxBytes: 5_242_880 });
		expect(
			configured({
				TRANSCRIPTION_MODEL: "openai/whisper-1",
				OPENAI_API_KEY: "k",
				TRANSCRIPTION_MAX_BYTES: "1000",
			}).transcription,
		).toMatchObject({ maxBytes: 1000 });
		expect(() => configured({ TRANSCRIPTION_MODEL: "openai/whisper-1", OPENAI_API_KEY: undefined }))
			.toThrow("needs OPENAI_API_KEY");
		expect(() => configured({ TRANSCRIPTION_MODEL: "somewhere/else", OPENAI_API_KEY: "k" }))
			.toThrow("TRANSCRIPTION_MODEL must be off, or openai/<model>");
		expect(() =>
			configured({
				TRANSCRIPTION_MODEL: "openai/whisper-1",
				OPENAI_API_KEY: "k",
				TRANSCRIPTION_MAX_BYTES: "0",
			})
		).toThrow("TRANSCRIPTION_MAX_BYTES must be a whole number");
	});
});

type Permissions = Repository["permissions"];

class FakeGitHub implements GitHub {
	access = new Map<string, Permissions>();
	authorize(): string {
		return "https://github.test/authorize";
	}
	async exchange(): Promise<GitHubTokenGrant> {
		return grant("ghu_octocat");
	}
	async refresh(): Promise<GitHubTokenGrant> {
		return grant("ghu_octocat");
	}
	async user() {
		return { id: "U_octocat", login: "octocat", avatarUrl: "avatar" };
	}
	async organizationMembership() {
		return undefined;
	}
	async installations() {
		return { installations: [], nextPage: undefined };
	}
	async installationRepositories() {
		return { repositories: [], nextPage: undefined };
	}
	async repository(): Promise<Repository> {
		throw new Error("not used");
	}
	async repositoryAccess(token: string, owner: string, name: string) {
		let permissions = this.access.get(`${token}:${name}`);
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

async function setup(
	options: { maxBytes: number } | null = { maxBytes: 64 },
	failure?: Error,
) {
	let now = new Date("2026-10-09T12:00:00.000Z");
	let storage = new MemoryStorage();
	let sessions = new Sessions(storage, true, () => now);
	let github = new FakeGitHub();
	let people: Record<string, string> = {};
	for (let login of ["octocat", "hubot", "outsider"]) {
		await storage.users.put({ id: `U_${login}`, login, avatarUrl: "a", now });
		people[login] = (await sessions.issue(`U_${login}`, grant(`ghu_${login}`))).cookie.split(
			";",
			1,
		)[0]!;
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
	let heard: Array<{ bytes: Uint8Array; type: string }> = [];
	let router = new Router();
	registerTranscriptionRoutes(
		router,
		auth,
		options
			? {
				...options,
				transcribe: async recording => {
					heard.push(recording);
					if (failure) throw failure;
					return " the cap is one hundred ";
				},
			}
			: undefined,
	);
	let channel = await storage.channels.create({
		id: crypto.randomUUID(),
		repositoryId: "R_score",
		repositoryOwner: "octo-org",
		repositoryName: "score",
		title: "Plan",
		createdBy: "U_octocat",
		now,
	});
	github.access.set("ghu_octocat:score", { pull: true, push: true, admin: false });
	github.access.set("ghu_hubot:score", { pull: true, push: false, admin: false });
	let post = (
		who: string | undefined,
		body: Uint8Array | string,
		headers: Record<string, string> = {},
	) =>
		router.handle(
			new Request(`${ORIGIN}/api/channels/${channel.id}/transcriptions`, {
				method: "POST",
				body: body as BodyInit,
				headers: { origin: ORIGIN, ...(who ? { cookie: people[who]! } : {}), ...headers },
			}),
		);
	return { post, heard, storage, channel };
}

describe("the transcription route", () => {
	it("turns a writer's recording into words, and sends the provider only what it is", async () => {
		let { post, heard } = await setup();
		let response = await post("octocat", WEBM);
		expect(response?.status).toBe(200);
		expect(await response!.json()).toEqual({ text: "the cap is one hundred" });
		expect(heard).toHaveLength(1);
		expect(heard[0]).toMatchObject({ type: "audio/webm" });
		expect(heard[0]!.bytes).toEqual(WEBM);
	});

	it("is not there at all where no model is configured: nothing is accepted, nothing is sent", async () => {
		let { post, heard } = await setup(null);
		expect((await post("octocat", WEBM))?.status).toBe(404);
		expect(heard).toEqual([]);
	});

	it("refuses what is not audio, what is too long, a reader, a stranger, a visitor and another origin", async () => {
		let { post, heard } = await setup();
		expect((await post("octocat", "<html>"))?.status).toBe(422);
		expect((await post("octocat", new Uint8Array([...WEBM, ...new Uint8Array(100)])))?.status).toBe(
			413,
		);
		expect((await post("hubot", WEBM))?.status).toBe(403);
		expect((await post("outsider", WEBM))?.status).toBe(404);
		expect((await post(undefined, WEBM))?.status).toBe(401);
		expect((await post("octocat", WEBM, { origin: "https://evil.test" }))?.status).toBe(403);
		expect(heard).toEqual([]);
	});

	it("says the provider failed without saying why, and sends nothing of its key", async () => {
		let { post } = await setup({ maxBytes: 64 }, new Error("provider said sk-secret is wrong"));
		let failed = await post("octocat", WEBM);
		expect(failed?.status).toBe(502);
		expect(JSON.stringify(await failed!.json())).not.toContain("sk-secret");
	});
});
