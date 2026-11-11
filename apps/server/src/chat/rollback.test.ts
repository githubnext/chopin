import { afterAll, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ulid } from "@chopin/dialect";

import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import { setup } from "./attachments.test-fixtures";
import { harness, installJobCleanup, member, until } from "./job.test-fixtures";
import * as Chat from "./service";
import * as Threads from "./threads";
import { DEBOUNCE_MS } from "./reaction-reply";
import { finishTurn, installReactionFixtures, reactAs } from "./reaction.test-fixtures";

import type { Chat as Wire } from "@chopin/protocol";
import type { Room as ReactionRoom } from "./reaction.test-fixtures";

installJobCleanup();

/**
 * A transcript this server writes must still open on the server it would be rolled back to, or a
 * rollback leaves documents that cannot be opened. The older server is the real one: a temporary
 * worktree of `ROLLBACK_BASE` (origin/main by default) run on a sidecar this checkout wrote.
 */
const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const BASE = process.env.ROLLBACK_BASE ?? "origin/main";
const READER = "apps/server/src/chat/rollback-reader.ts";

function git(...args: string[]) {
	return Bun.spawnSync(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
}

let available = git("rev-parse", "--verify", "--quiet", `${BASE}^{commit}`).exitCode === 0;

/** `node_modules` for a worktree: third-party packages are this checkout's, workspace packages the worktree's own. */
function linkModules(worktree: string) {
	let link = (from: string, to: string) => {
		mkdirSync(dirname(to), { recursive: true });
		symlinkSync(from, to);
	};
	let visit = (directory: string) => {
		let modules = join(ROOT, directory, "node_modules");
		if (!existsSync(modules)) return;
		for (let name of readdirSync(modules)) {
			let original = join(modules, name);
			let target = join(worktree, directory, "node_modules", name);
			if (name !== "@chopin") {
				link(original, target);
				continue;
			}
			for (let workspace of readdirSync(original)) {
				let source = resolve(original, readlinkSync(join(original, workspace)));
				link(join(worktree, relative(ROOT, source)), join(target, workspace));
			}
		}
	};
	visit(".");
	for (let group of ["apps", "packages"]) {
		for (let name of readdirSync(join(ROOT, group))) visit(join(group, name));
	}
}

type Read = { ok: true; entries: Array<Record<string, unknown>> } | { ok: false; error: string };

async function read(directory: string, sidecar: string): Promise<Read> {
	let child = Bun.spawn(["bun", join(directory, READER), sidecar], {
		cwd: directory,
		stdout: "pipe",
		stderr: "pipe",
	});
	let [out, err] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	await child.exited;
	let line = out.trim().split("\n").at(-1) ?? "";
	try {
		return JSON.parse(line) as Read;
	} catch {
		throw new Error(`the reader printed no result: ${out.slice(-400)} ${err.slice(-600)}`);
	}
}

let worktree: string | undefined;
let scratch = mkdtempSync(join(tmpdir(), "chopin-rollback-"));

/** A temporary worktree of the server it would be rolled back to, made once. */
function olderServer(): string {
	if (worktree) return worktree;
	let made = join(scratch, "base");
	let added = git("worktree", "add", "--detach", made, BASE);
	expect(added.exitCode, new TextDecoder().decode(added.stderr)).toBe(0);
	linkModules(made);
	worktree = made;
	return made;
}

afterAll(() => {
	if (worktree) {
		git("worktree", "remove", "--force", worktree);
		git("worktree", "prune");
	}
	rmSync(scratch, { recursive: true, force: true });
});

/** The sidecar this server writes for a Chat holding messages sent with files, from the real send. */
async function written(): Promise<{ sidecar: Record<string, unknown>; ids: string[] }> {
	let { h, upload, send } = await setup();
	let image = await upload(
		"U_ana",
		"shot.png",
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]),
		"image",
	);
	let notes = await upload("U_ana", "notes.md", "# Notes\n");
	let only = await upload("U_ana", "only.txt", "only a file");
	let planner = await upload("U_ana", "planner.md", "for the planner");
	let first = await send({
		to: "room",
		text: "The plan and a picture",
		attachments: [image, notes],
	});
	let second = await send({ to: "room", text: "", attachments: [only] });
	let third = await send({ to: "planner", text: "Read this", attachments: [planner] });
	expect([first, second, third].map(sent => sent.reply?.kind)).toEqual([
		"chat:send",
		"chat:send",
		"chat:send",
	]);
	await until(() => !h.chat.busy);
	let entries = h.chat.entries.filter(entry => entry.attachments?.length);
	expect(entries.map(entry => entry.attachments!.length).sort()).toEqual([1, 1, 2]);
	let context = await openPlan();
	context.plan.chat.entries.push(...(structuredClone(h.chat.entries) as Wire.Entry[]));
	await Service.persist(context.plan);
	await Service.close(context.plan);
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
		string,
		unknown
	>;
	return { sidecar, ids: entries.map(entry => entry.id) };
}

describe("a transcript with files in it, on the server it would be rolled back to", () => {
	it("is opened by this checkout with every file kept, as the control", async () => {
		let { sidecar, ids } = await written();
		let file = join(scratch, "control.json");
		await Bun.write(file, JSON.stringify(sidecar));
		let result = await read(ROOT, file);
		expect(result.ok, JSON.stringify(result)).toBe(true);
		let entries = (result as Extract<Read, { ok: true }>).entries;
		for (let id of ids) {
			expect(entries.find(entry => entry.id === id)?.attachments, id).toBeArray();
		}
	}, 120_000);

	it.skipIf(!available)(
		`is opened by the real ${BASE} reader, with the same messages and no file lost to it`,
		async () => {
			let worktree = olderServer();
			await Bun.write(join(worktree, READER), Bun.file(join(ROOT, READER)));

			let { sidecar, ids } = await written();
			let file = join(scratch, "written.json");
			await Bun.write(file, JSON.stringify(sidecar));
			let older = await read(worktree, file);
			expect(older.ok, JSON.stringify(older)).toBe(true);
			let [before, after] = [
				sidecar.transcript as Array<Record<string, unknown>>,
				(older as Extract<Read, { ok: true }>).entries,
			];
			// Every message is there with the words and the sender it had.
			expect(after.map(entry => entry.id)).toEqual(before.map(entry => entry.id));
			for (let entry of before) {
				let kept = after.find(value => value.id === entry.id)!;
				expect(kept.text, String(entry.id)).toBe(entry.text);
				expect(kept.author, String(entry.id)).toEqual(entry.author);
				expect(kept.delivery, String(entry.id)).toEqual(entry.delivery);
			}
			expect(ids).toHaveLength(3);

			// It is the older server's own check that ran: it refuses a transcript that is not one.
			let broken = structuredClone(sidecar) as { transcript: Array<Record<string, unknown>> };
			broken.transcript[0]!.text = 5;
			let bad = join(scratch, "broken.json");
			await Bun.write(bad, JSON.stringify(broken));
			let refused = await read(worktree, bad);
			expect(refused).toMatchObject({ ok: false });
			expect((refused as { error: string }).error).toContain("invalid transcript entry");
		},
		240_000,
	);
});

/**
 * The sidecar for a Chat holding a message that points at things the composer can point at: a
 * command, a heading of the document, a file of its repository and a Decision, among a reference
 * to another document and one to a research card. The older server restores references strictly and
 * knows only the last two.
 */
async function writtenWithPointers(): Promise<
	{ sidecar: Record<string, unknown>; id: string; references: Array<Record<string, unknown>> }
> {
	let context = await openPlan();
	let text = "/research @Overview, @src/index.ts and @Choice";
	let at = (token: string) => ({
		start: text.indexOf(token),
		end: text.indexOf(token) + token.length,
	});
	let references = [
		{
			id: ulid(),
			kind: "command",
			name: "research",
			commandKind: "skill",
			label: "/research",
			...at("/research"),
		},
		{
			id: ulid(),
			kind: "heading",
			anchor: "overview",
			level: 1,
			line: 1,
			label: "@Overview",
			...at("@Overview"),
		},
		{
			id: ulid(),
			kind: "file",
			path: "src/index.ts",
			label: "@src/index.ts",
			...at("@src/index.ts"),
		},
		{ id: ulid(), kind: "decision", decisionId: ulid(), label: "@Choice", ...at("@Choice") },
	];
	let id = ulid();
	context.plan.chat.entries.push(
		{
			id,
			author: { kind: "member", handle: "ana" },
			text,
			ts: 1_700_000_000,
			references,
		} as unknown as Wire.Entry,
		{
			id: ulid(),
			author: { kind: "member", handle: "ana" },
			text: "A message that points nowhere.",
			ts: 1_700_000_001,
		} as Wire.Entry,
	);
	await Service.persist(context.plan);
	await Service.close(context.plan);
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
		string,
		unknown
	>;
	return { sidecar, id, references };
}

describe("a transcript with pointers in it, on the server it would be rolled back to", () => {
	it(
		"is opened by this checkout with every reference back, in the order of the text, as the control",
		async () => {
			let { sidecar, id, references } = await writtenWithPointers();
			let file = join(scratch, "pointers-control.json");
			await Bun.write(file, JSON.stringify(sidecar));
			let result = await read(ROOT, file);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			let entries = (result as Extract<Read, { ok: true }>).entries;
			expect(entries.find(entry => entry.id === id)?.references).toEqual(references);
			// The sidecar keeps them where a server without them does not look.
			let stored = (sidecar.transcript as Array<Record<string, unknown>>).find(entry =>
				entry.id === id
			)!;
			expect(stored.references).toBeUndefined();
			expect(stored.pointers).toEqual(references);
		},
		120_000,
	);

	it.skipIf(!available)(
		`is opened by the real ${BASE} reader, with the same messages and the words the pointers were written in`,
		async () => {
			let older = olderServer();
			await Bun.write(join(older, READER), Bun.file(join(ROOT, READER)));
			let { sidecar, id } = await writtenWithPointers();
			let file = join(scratch, "pointers-written.json");
			await Bun.write(file, JSON.stringify(sidecar));
			let result = await read(older, file);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			let entries = (result as Extract<Read, { ok: true }>).entries;
			let before = sidecar.transcript as Array<Record<string, unknown>>;
			expect(entries.map(entry => entry.id)).toEqual(before.map(entry => entry.id));
			for (let entry of before) {
				expect(entries.find(value => value.id === entry.id)!.text, String(entry.id)).toBe(
					entry.text,
				);
			}
			// The older server reads the pointers as the plain words of the message.
			expect(entries.find(entry => entry.id === id)!.text).toBe(
				"/research @Overview, @src/index.ts and @Choice",
			);
		},
		240_000,
	);
});

/**
 * The sidecar this server writes for a Chat holding reactions on member, Planner and system
 * messages, `answeredIntents` on a Planner message whose reaction was answered, and `viaReaction`
 * on the Planner's reply.
 */
async function writtenWithReactions(
	makeRoom: () => Promise<ReactionRoom>,
): Promise<{ sidecar: Record<string, unknown> }> {
	let h = await makeRoom();
	await reactAs(h, "ana", "✅", true, "m0");
	await reactAs(h, "ben", "👍🏽", true, "m0");
	await reactAs(h, "ana", "👀", true, "s1");
	await reactAs(h, "ben", "❓", true, "a1");
	await h.clock.advance(DEBOUNCE_MS);
	await until(() => h.prompts.length === 1);
	await finishTurn(h, "Let me explain that section.");

	let context = await openPlan();
	context.plan.chat.entries.push(...(structuredClone(h.chat.entries) as Wire.Entry[]));
	await Service.persist(context.plan);
	await Service.close(context.plan);
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
		string,
		unknown
	>;
	return { sidecar };
}

describe("a transcript with reactions in it, on the server it would be rolled back to", () => {
	let reactionFixtures = installReactionFixtures();

	it(
		"is opened by this checkout with every reaction, answered reading and reaction-turn mark kept",
		async () => {
			let { sidecar } = await writtenWithReactions(() => reactionFixtures.room());
			let file = join(scratch, "reactions-control.json");
			await Bun.write(file, JSON.stringify(sidecar));
			let result = await read(ROOT, file);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			let entries = (result as Extract<Read, { ok: true }>).entries;
			expect(entries.find(entry => entry.id === "m0")?.reactions).toEqual([
				{ emoji: "✅", handles: ["ana"] },
				{ emoji: "👍🏽", handles: ["ben"] },
			]);
			expect(entries.find(entry => entry.id === "a1")).toMatchObject({
				reactions: [{ emoji: "❓", handles: ["ben"] }],
				answeredIntents: ["confused"],
			});
			expect(entries.at(-1)).toMatchObject({
				author: { kind: "agent" },
				text: "Let me explain that section.",
				viaReaction: true,
			});

			let broken = structuredClone(sidecar) as { transcript: Array<Record<string, unknown>> };
			broken.transcript[0]!.reactions = "not-an-array";
			let bad = join(scratch, "reactions-broken.json");
			await Bun.write(bad, JSON.stringify(broken));
			let refused = await read(ROOT, bad);
			expect(refused).toMatchObject({ ok: false });
			expect((refused as { error: string }).error).toContain("invalid chat reactions");
		},
		120_000,
	);

	it.skipIf(!available)(
		`is opened by the real ${BASE} reader, with every message and reaction entry readable`,
		async () => {
			let older = olderServer();
			let { sidecar } = await writtenWithReactions(() => reactionFixtures.room());
			let file = join(scratch, "reactions-written.json");
			await Bun.write(file, JSON.stringify(sidecar));
			let result = await read(older, file);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			let entries = (result as Extract<Read, { ok: true }>).entries;
			let before = sidecar.transcript as Array<Record<string, unknown>>;
			expect(entries.map(entry => entry.id)).toEqual(before.map(entry => entry.id));
			for (let entry of before) {
				let kept = entries.find(value => value.id === entry.id)!;
				expect(kept.text, String(entry.id)).toBe(entry.text);
				expect(kept.author, String(entry.id)).toEqual(entry.author);
			}
			expect(entries.at(-1)?.text).toBe("Let me explain that section.");
		},
		240_000,
	);
});

describe("a document with Chat threads and session compactions, on the server it would be rolled back to", () => {
	it.skipIf(!available)(
		`is opened by the real ${BASE} reader with top-level and alsoToChat messages intact and thread replies outside the sidecar`,
		async () => {
			let older = olderServer();
			await Bun.write(join(older, READER), Bun.file(join(ROOT, READER)));
			let { h, ana } = await setup();
			let topRoom = Threads.bindTopLevel(h.context);
			let rootId = crypto.randomUUID();
			await Threads.sendMessage(topRoom, ana, {
				kind: "chat:send",
				rid: "rb-1",
				requestId: rootId,
				to: "room",
				text: "Root message before thread",
				ts: 0,
			});
			await Threads.sendMessage(topRoom, ana, {
				kind: "chat:send",
				rid: "rb-2",
				requestId: crypto.randomUUID(),
				to: "room",
				thread: rootId,
				text: "Private side-thread reply",
				ts: 0,
			});
			await Threads.sendMessage(topRoom, ana, {
				kind: "chat:send",
				rid: "rb-3",
				requestId: crypto.randomUUID(),
				to: "room",
				thread: rootId,
				alsoToChat: true,
				text: "Summary shared back to Chat",
				ts: 0,
			});
			let context = await openPlan();
			context.plan.chat.entries.push(...(structuredClone(h.chat.entries) as Wire.Entry[]));
			await Service.persist(context.plan);
			await Service.close(context.plan);
			let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
			let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
				string,
				unknown
			>;
			let file = join(scratch, "threads-written.json");
			await Bun.write(file, JSON.stringify(sidecar));
			let result = await read(older, file);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			let entries = (result as Extract<Read, { ok: true }>).entries;
			expect(entries.map(entry => entry.text)).toEqual([
				"Root message before thread",
				"Summary shared back to Chat",
			]);
		},
		240_000,
	);
});

describe("a transcript with a message given to the running turn, on the server it would be rolled back to", () => {
	it.skipIf(!available)(
		`is opened by the real ${BASE} reader with every message, the steered one included, as an ordinary one`,
		async () => {
			let older = olderServer();
			await Bun.write(join(older, READER), Bun.file(join(ROOT, READER)));
			let h = harness();
			let speaking = (handle: string) =>
				({ data: { handle, principalId: `U_${handle}` }, send: () => {} }) as never;
			await Chat.send(h.context, speaking("ana"), member("@chopin plan the rollout"));
			await until(() => h.prompts.length === 1);
			await Chat.send(h.context, speaking("bo"), member("@chopin also cover the rollback"));
			await until(() => h.steered.length === 1);
			await Chat.send(h.context, speaking("bo"), { ...member("Thanks, team"), to: "room" });
			h.emit("session.idle");
			await until(() => !h.chat.busy);
			let context = await openPlan();
			context.plan.chat.entries.push(...(structuredClone(h.chat.entries) as Wire.Entry[]));
			await Service.persist(context.plan);
			await Service.close(context.plan);
			let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
			let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
				string,
				unknown
			>;
			let file = join(scratch, "steered-written.json");
			await Bun.write(file, JSON.stringify(sidecar));
			let result = await read(older, file);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			let entries = (result as Extract<Read, { ok: true }>).entries;
			expect(entries.map(entry => entry.text)).toEqual([
				"plan the rollout",
				"also cover the rollback",
				"Thanks, team",
			]);
			// Nothing the older server reads says a message waits, was sent or failed.
			for (let entry of entries) expect(entry.deliveryState).toBeUndefined();
		},
		240_000,
	);
});

async function writtenWithPlannerImages(): Promise<
	{ sidecar: Record<string, unknown>; id: string }
> {
	let context = await openPlan();
	let id = ulid();
	let sha = "a".repeat(64);
	context.plan.chat.entries.push({
		id,
		author: { kind: "agent" },
		text: "Here are the diagrams.",
		ts: 1_700_000_000,
		images: [
			{
				src: `/images/${sha}.png`,
				alt: "Cache write-back diagram",
				caption: "Writes buffer before flushing.",
				width: 960,
				height: 420,
				generated: true,
			},
		],
		refusedImages: [
			{ before: 1, reason: "Image too large to show (12 MB, limit 10 MB)" },
		],
	});
	await Service.persist(context.plan);
	await Service.close(context.plan);
	let loaded = (await context.storage.collaboration.load(context.channel.id, context.now))!;
	let sidecar = structuredClone(loaded.sidecar ?? loaded.snapshot!.sidecar) as Record<
		string,
		unknown
	>;
	return { sidecar, id };
}

describe("a transcript with Planner images and refused images in it, on the server it would be rolled back to", () => {
	it("is opened by this checkout with its images and refusals intact", async () => {
		let { sidecar, id } = await writtenWithPlannerImages();
		let file = join(scratch, "images-control.json");
		await Bun.write(file, JSON.stringify(sidecar));
		let result = await read(ROOT, file);
		expect(result.ok, JSON.stringify(result)).toBe(true);
		let entry = (result as Extract<Read, { ok: true }>).entries.find(item => item.id === id)!;
		expect(entry.images).toHaveLength(1);
		expect(entry.refusedImages).toHaveLength(1);
	}, 120_000);

	it.skipIf(!available)(
		`is opened by the real ${BASE} reader without refusing the transcript`,
		async () => {
			let older = olderServer();
			await Bun.write(join(older, READER), Bun.file(join(ROOT, READER)));
			let { sidecar, id } = await writtenWithPlannerImages();
			let file = join(scratch, "images-written.json");
			await Bun.write(file, JSON.stringify(sidecar));
			let result = await read(older, file);
			expect(result.ok, JSON.stringify(result)).toBe(true);
			let entry = (result as Extract<Read, { ok: true }>).entries.find(item => item.id === id)!;
			expect(entry.text).toBe("Here are the diagrams.");
			expect(entry.author).toEqual({ kind: "agent" });
		},
		240_000,
	);
});
