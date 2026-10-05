import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Chat from "./scripted-runner.test-chat";
import * as room from "../plan/room";
import * as Service from "../plan/service";
import { openPlan } from "../testing/plan";
import type { Job } from "./jobs";
import { scriptedRunner } from "./scripted-runner";

let plans: Service.Plan[] = [];
let directories: string[] = [];
afterEach(async () => {
	for (let plan of plans) await Service.close(plan);
	for (let directory of directories) await rm(directory, { recursive: true, force: true });
	plans = [];
	directories = [];
});

async function directory(): Promise<string> {
	let path = await mkdtemp(join(tmpdir(), "planner-jobs-"));
	directories.push(path);
	return path;
}

function heading(): Job {
	return {
		id: "heading:document:m0",
		kind: "heading",
		target: "document",
		trigger: "m0",
		status: "running",
		attempts: 0,
		at: "2026-09-25T10:00:00.000Z",
	};
}

test("a scripted heading runs the real job tool while ordinary writing is refused", async () => {
	let { plan, server } = await openPlan("\n");
	plans.push(plan);
	let path = await directory();
	await writeFile(
		join(path, "heading.json"),
		JSON.stringify([
			{
				tool: "edit_plan",
				args: { revision: "$revision", operations: [{ op: "insert_root", source: "x\n" }] },
			},
			{
				tool: "draft_heading",
				args: { revision: "$revision", title: "Auth Strategy", goal: "Goal: pick auth." },
			},
		]),
	);
	let context: Chat.Room = {
		chat: plan.chat,
		plan,
		server,
		room: "test",
		persist: () => Service.persist(plan),
	} as Chat.Room;
	let run = scriptedRunner(path, () => Chat.planTools(context), plan.chat, () => plan.revision);
	expect(await run(heading(), "prompt")).toEqual({
		status: "done",
		output: JSON.stringify({ title: "Auth Strategy", goal: "Goal: pick auth." }),
	});
	expect(room.project(plan.document)).toBe("# Auth Strategy\n\nGoal: pick auth.\n");
	expect(plan.chat.job).toBeUndefined();
	expect(plan.chat.turn).toBeUndefined();
});

test("missing scripts skip, malformed scripts fail, and an active turn is never overwritten", async () => {
	let { plan } = await openPlan("\n");
	plans.push(plan);
	let path = await directory();
	let run = scriptedRunner(path, () => [], plan.chat, () => plan.revision);
	expect(await run(heading(), "prompt")).toMatchObject({ status: "skipped" });
	await writeFile(join(path, "heading.json"), "{not JSON");
	expect(await run(heading(), "prompt")).toMatchObject({ status: "failed" });
	let turn = { id: "existing", handle: "chopin", started: 1, entryOffset: 0, responded: false };
	plan.chat.turn = turn;
	expect(await run(heading(), "prompt")).toMatchObject({ status: "failed" });
	expect(plan.chat.turn).toBe(turn);
});

test("a held script waits for release and aborts promptly when its job service stops", async () => {
	let { plan } = await openPlan("\n");
	plans.push(plan);
	let path = await directory();
	await writeFile(join(path, "heading.json"), JSON.stringify([]));
	await writeFile(join(path, "heading.hold"), "hold");
	let controller = new AbortController();
	let run = scriptedRunner(path, () => [], plan.chat, () => plan.revision, controller.signal);
	let pending = run(heading(), "prompt");
	await Bun.sleep(50);
	expect(plan.chat.job?.id).toBe(heading().id);
	controller.abort();
	expect(await pending).toMatchObject({ status: "skipped" });
	expect(plan.chat.job).toBeUndefined();
	expect(plan.chat.turn).toBeUndefined();
});

test("a replaced job keeps its new turn and output after an old scripted call finishes", async () => {
	let { plan } = await openPlan("\n");
	plans.push(plan);
	let path = await directory();
	await writeFile(
		join(path, "heading.json"),
		JSON.stringify([{
			tool: "draft_heading",
			args: {},
		}]),
	);
	let entered = Promise.withResolvers<void>();
	let release = Promise.withResolvers<void>();
	let run = scriptedRunner(
		path,
		() =>
			[{
				name: "draft_heading",
				handler: async () => {
					entered.resolve();
					await release.promise;
					return "{}";
				},
			}] as never,
		plan.chat,
		() => plan.revision,
	);
	let pending = run(heading(), "prompt");
	await entered.promise;
	let replacement = { ...heading(), id: "heading:document:m2" };
	let turn = { id: "new-turn", handle: "chopin", started: 2, entryOffset: 0, responded: false };
	plan.chat.job = replacement;
	plan.chat.turn = turn;
	plan.chat.jobOutput = "new output";
	release.resolve();
	expect(await pending).toMatchObject({ status: "skipped" });
	expect(plan.chat.job).toBe(replacement);
	expect(plan.chat.turn).toBe(turn);
	expect(plan.chat.jobOutput).toBe("new output");
});
