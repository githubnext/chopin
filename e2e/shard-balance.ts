/**
 * Shards the browser suite by recorded duration instead of by test count.
 *
 * Playwright's own `--shard` cuts the test list into equal counts, so one CI
 * shard can draw most of the slow files and finish minutes after the others.
 * Add this reporter beside the others (`--reporter=github,blob,./e2e/shard-balance.ts`)
 * and it takes over sharding: every runner sees the same full suite, places
 * whole files on the least loaded shard, longest first, and runs only its own.
 * Whole files keep a `mode: "default"` file on one worker, as Playwright does.
 *
 * The weights in `shard-timings.json` only decide placement. A file missing from
 * them, or a stale entry, still runs exactly once; it is only weighed by its test
 * count. Refresh them with `bun scripts/e2e-shard-timings.ts <integration.json>`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { FullConfig, Reporter, Suite, TestRun } from "@playwright/test/reporter";

type Timings = Record<string, { ms: number; tests: number }>;

export default class ShardBalance implements Reporter {
	async preprocess(
		{ config, suite, testRun }: { config: FullConfig; suite: Suite; testRun: TestRun },
	) {
		let shard = config.shard;
		if (!shard || shard.total < 2) return;
		let timings: Timings = JSON.parse(
			readFileSync(join(dirname(fileURLToPath(import.meta.url)), "shard-timings.json"), "utf8"),
		);
		let known = Object.values(timings);
		let perTest = known.reduce((sum, entry) => sum + entry.ms, 0)
			/ Math.max(1, known.reduce((sum, entry) => sum + entry.tests, 0));

		let files: { key: string; suite: Suite; weight: number }[] = [];
		for (let project of suite.suites) {
			for (let file of project.suites) {
				let name = relative(config.rootDir, file.location?.file ?? file.title);
				let tests = file.allTests().length;
				let entry = timings[name];
				let weight = entry && entry.tests > 0 ? (entry.ms / entry.tests) * tests : perTest * tests;
				files.push({ key: `${project.title}\0${name}`, suite: file, weight });
			}
		}
		files.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

		let load = Array.from({ length: shard.total }, () => 0);
		testRun.skipSharding();
		for (let file of files) {
			let target = load.indexOf(Math.min(...load));
			load[target]! += file.weight;
			if (target !== shard.current - 1) testRun.exclude(file.suite);
		}
	}

	printsToStdio() {
		return false;
	}
}
