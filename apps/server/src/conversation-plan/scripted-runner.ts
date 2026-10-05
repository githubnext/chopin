/** Test-only Planner runner: real scoped tools, with calls read from a local script. */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ulid } from "@chopin/dialect";
import { type Call, calls, held, MAX_SCRIPT_BYTES, reason, substitute } from "./scripted-script";

type Tool = {
	name: string;
	handler?: (args: unknown, context: unknown) => unknown | Promise<unknown>;
};
import type { Chat } from "../chat/service";
import type { Job, JobOutcome } from "./jobs";
import type { PlannerJobRunner } from "./planner-jobs";

export function scriptedRunner(
	dir: string,
	tools: (job: Job) => Tool[],
	chat: Chat,
	revision: () => number,
	signal?: AbortSignal,
): PlannerJobRunner {
	return async (job, _prompt, runnerSignal): Promise<JobOutcome> => {
		let activeSignal = runnerSignal ?? signal;
		let script: Call[];
		try {
			let data = await readFile(join(dir, `${job.kind}.json`), "utf8");
			if (data.length > MAX_SCRIPT_BYTES) throw new Error("scripted Planner job is too large");
			script = calls(JSON.parse(data));
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ENOENT"
				? { status: "skipped", reason: `no script for ${job.kind}` }
				: { status: "failed", reason: reason(error) };
		}
		if (activeSignal?.aborted || chat.closed) {
			return { status: "skipped", reason: "The scripted Planner job stopped." };
		}
		if (chat.busy || chat.turn || chat.job) {
			return { status: "failed", reason: "Another Planner turn is active." };
		}
		let turn: NonNullable<Chat["turn"]> = {
			id: ulid(),
			handle: "chopin",
			started: Date.now(),
			entryOffset: chat.entries.length,
			responded: false,
		};
		chat.busy = true;
		chat.turn = turn;
		chat.job = job;
		chat.jobOutput = undefined;
		chat.jobFailures = 0;
		chat.jobCalls = new Map();
		try {
			let gate = await held(dir, job.kind, activeSignal);
			if (gate === "timed-out") {
				return { status: "failed", reason: "Scripted Planner job hold timed out." };
			}
			if (
				gate !== "released" || activeSignal?.aborted || chat.closed
				|| chat.job !== job || chat.turn !== turn
			) {
				return { status: "skipped", reason: "The scripted Planner job stopped." };
			}
			let available = tools(job);
			let failed: string | undefined;
			for (let call of script) {
				if (activeSignal?.aborted || chat.closed || chat.job !== job || chat.turn !== turn) {
					return { status: "skipped", reason: "The scripted Planner job stopped." };
				}
				let tool = available.find(item => item.name === call.tool);
				if (!tool?.handler) return { status: "failed", reason: `no tool ${call.tool}` };
				try {
					let result = await tool.handler(
						substitute(call.args, revision(), job.target) as never,
						{} as never,
					);
					if (typeof result === "string") {
						let parsed: unknown;
						try {
							parsed = JSON.parse(result);
						} catch {}
						if (parsed && typeof parsed === "object" && "ok" in parsed && !parsed.ok) {
							failed = reason("error" in parsed ? parsed.error : result);
						}
					}
				} catch (error) {
					failed = reason(error);
				}
				if (activeSignal?.aborted || chat.closed || chat.job !== job || chat.turn !== turn) {
					return { status: "skipped", reason: "The scripted Planner job stopped." };
				}
			}
			return chat.jobOutput === undefined
				? { status: "failed", reason: failed ?? "The script called no job tool successfully." }
				: { status: "done", output: chat.jobOutput };
		} catch (error) {
			return { status: "failed", reason: reason(error) };
		} finally {
			if (chat.job === job && chat.turn === turn) {
				chat.job = undefined;
				chat.jobOutput = undefined;
				chat.jobFailures = undefined;
				chat.jobCalls = undefined;
				chat.turn = undefined;
				chat.busy = false;
			}
		}
	};
}
