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
import { installJobCleanup, until } from "./job.test-fixtures";

import type { Chat as Wire } from "@chopin/protocol";

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
