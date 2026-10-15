import { isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Limits } from "./types";

export type Options = Limits & {
	instructions?: string;
	cases: string[];
	live: boolean;
	list: boolean;
	model: string;
	out: string;
	runId: string;
	label: string;
	visual: "off" | "fixture-prose";
};

export function options(args: string[]): Options {
	let result: Options = {
		cases: ["coworker-confusion", "user-correction"],
		live: false,
		list: false,
		model: "gpt-6-luna",
		out: resolve(tmpdir(), "chopin-planner-coach"),
		runId: new Date().toISOString().replaceAll(":", "-"),
		label: "unlabelled",
		visual: "off",
		maxTools: 16,
		turnTimeoutMs: 120_000,
		questionWaitMs: 2_000,
	};
	for (let i = 0; i < args.length; i++) {
		let flag = args[i];
		if (flag === "--live") {
			result.live = true;
			continue;
		}
		if (flag === "--list") {
			result.list = true;
			continue;
		}
		let value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
		switch (flag) {
			case "--instructions":
				result.instructions = resolve(value);
				break;
			case "--cases":
				result.cases = value.split(",");
				break;
			case "--model":
				result.model = value;
				break;
			case "--out":
				if (!isAbsolute(value)) throw new Error("--out must be an absolute path");
				result.out = resolve(value);
				break;
			case "--run-id":
				result.runId = value;
				break;
			case "--label":
				result.label = value;
				break;
			case "--visual":
				if (value !== "off" && value !== "fixture-prose") throw new Error("Invalid --visual");
				result.visual = value;
				break;
			case "--max-tools":
				result.maxTools = integer(value, 1, 50);
				break;
			case "--turn-timeout-ms":
				result.turnTimeoutMs = integer(value, 1_000, 300_000);
				break;
			case "--question-wait-ms":
				result.questionWaitMs = integer(value, 100, 10_000);
				break;
			default:
				throw new Error(`Unknown option ${flag}`);
		}
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(result.runId)) {
		throw new Error("--run-id must be a safe directory name of at most 80 characters");
	}
	if (result.live && !result.instructions) throw new Error("Live runs require --instructions");
	if (result.cases.some(id => !id) || new Set(result.cases).size !== result.cases.length) {
		throw new Error("Case IDs must be nonempty and unique");
	}
	return result;
}

function integer(value: string, min: number, max: number): number {
	let parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`Expected integer between ${min} and ${max}`);
	}
	return parsed;
}
