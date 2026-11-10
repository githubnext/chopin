import { afterEach, expect, it } from "bun:test";
import { AuthStorage, ModelRuntime } from "@bastani/atomic";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionCommands } from "./adapter";

let directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.map(path => rm(path, { recursive: true, force: true })));
	directories = [];
});

async function directory(): Promise<string> {
	let path = await mkdtemp(join(tmpdir(), "chopin-commands-"));
	directories.push(path);
	return path;
}

it(
	"lists a Planner's prompt templates, skills and workflows as the commands Atomic runs",
	async () => {
		let cwd = await directory();
		let agentDir = await directory();
		await mkdir(join(cwd, ".atomic", "skills", "release-notes"), { recursive: true });
		await writeFile(
			join(cwd, ".atomic", "skills", "release-notes", "SKILL.md"),
			"---\nname: release-notes\ndescription: Draft release notes from merged pull requests.\n---\nDo it.\n",
		);
		await mkdir(join(cwd, ".atomic", "prompts"), { recursive: true });
		await writeFile(
			join(cwd, ".atomic", "prompts", "review.md"),
			"---\ndescription: Review the current diff\n---\nReview $ARGUMENTS\n",
		);
		await mkdir(join(cwd, ".atomic", "workflows"), { recursive: true });
		let runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({}),
			modelsPath: null,
			allowModelNetwork: false,
		});

		let commands = await sessionCommands(runtime, { extensions: [] }, cwd, agentDir);

		// Prompt templates and skills come with the name Atomic invokes them by.
		expect(commands).toContainEqual({
			name: "review",
			description: "Review the current diff",
			kind: "prompt",
		});
		expect(commands).toContainEqual({
			name: "skill:release-notes",
			description: "Draft release notes from merged pull requests.",
			kind: "skill",
		});
		// The workflows Atomic registers for every session are listed with theirs.
		let workflows = commands.filter(command => command.kind === "workflow");
		expect(workflows.length).toBeGreaterThan(0);
		expect(workflows.every(command => command.name !== "")).toBe(true);
		// Atomic's own extension commands, such as /workflow itself, are not offered.
		expect(commands.some(command => command.name === "workflow" && command.kind !== "workflow"))
			.toBe(false);
		expect(
			commands.map(command => command.kind).every(kind =>
				kind === "prompt" || kind === "skill" || kind === "workflow"
			),
		).toBe(true);
	},
	60_000,
);
