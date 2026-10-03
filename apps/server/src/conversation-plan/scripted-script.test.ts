import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { held, readScript, substitute } from "./scripted-script";

let directories: string[] = [];
afterEach(async () => {
	for (let directory of directories) await rm(directory, { recursive: true, force: true });
	directories = [];
});

async function directory(): Promise<string> {
	let path = await mkdtemp(join(tmpdir(), "planner-script-loader-"));
	directories.push(path);
	return path;
}

async function script(value: unknown): Promise<string> {
	let path = await directory();
	await writeFile(join(path, "heading.json"), JSON.stringify(value));
	return path;
}

test("readScript preserves exact calls through the sixteen-call limit", async () => {
	let calls = Array.from({ length: 16 }, (_, index) => ({
		tool: "draft_heading",
		args: { revision: "$revision", title: `Heading ${index}`, goal: "$target" },
	}));
	let path = await script(calls);
	expect(await readScript(path, "heading")).toEqual(calls);
});

test.each([
	["seventeen calls", Array.from({ length: 17 }, () => ({ tool: "read_plan", args: {} }))],
	["extra call field", [{ tool: "read_plan", args: {}, extra: true }]],
	["array args", [{ tool: "read_plan", args: [] }]],
	["null args", [{ tool: "read_plan", args: null }]],
	["invalid tool", [{ tool: "read-plan", args: {} }]],
])("readScript rejects %s", async (_name, value) => {
	let path = await script(value);
	await expect(readScript(path, "heading")).rejects.toThrow("calls are invalid");
});

test("readScript retains the original string length bound rather than UTF-8 byte count", async () => {
	let calls = [{ tool: "draft_heading", args: { title: "é".repeat(40_000) } }];
	let path = await script(calls);
	expect(await readScript(path, "heading")).toEqual(calls);
	await writeFile(
		join(path, "heading.json"),
		JSON.stringify([
			{ tool: "draft_heading", args: { title: "x".repeat(64 * 1024) } },
		]),
	);
	await expect(readScript(path, "heading")).rejects.toThrow("scripted Planner job is too large");
});

test("readScript exposes the original missing-file and malformed-JSON errors", async () => {
	let path = await directory();
	await expect(readScript(path, "heading")).rejects.toMatchObject({ code: "ENOENT" });
	await writeFile(join(path, "heading.json"), "{not JSON");
	await expect(readScript(path, "heading")).rejects.toBeInstanceOf(SyntaxError);
});

test("substitution replaces nested markers and refuses depth beyond sixteen", () => {
	expect(substitute({ revision: "$revision", values: ["$target", { keep: "literal" }] }, 7, "q1"))
		.toEqual({ revision: 7, values: ["q1", { keep: "literal" }] });
	let nested: unknown = "$revision";
	for (let depth = 0; depth < 16; depth++) nested = [nested];
	expect(() => substitute(nested, 7, "q1")).not.toThrow();
	expect(() => substitute([nested], 7, "q1")).toThrow("arguments are too deep");
});

test("an actual hold file respects release and abort conditions", async () => {
	let path = await directory();
	await writeFile(join(path, "heading.hold"), "hold");
	await writeFile(join(path, "heading.release"), "release");
	expect(await held(path, "heading")).toBe("released");
	await rm(join(path, "heading.release"));
	let controller = new AbortController();
	controller.abort();
	expect(await held(path, "heading", controller.signal)).toBe("stopped");
});
