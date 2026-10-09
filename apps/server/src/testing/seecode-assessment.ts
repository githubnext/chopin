/** Small live Planner check against frozen development discussions. */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { HarnessAgent } from "@ai-sdk/harness/agent";
import { z } from "zod";

import { PROMPT } from "../agent/planner";
import { createCopilotSdk } from "../harness/copilot-sdk/adapter";
import * as Room from "../plan/room";

// Load the agent's tool registry first; the live chat and service modules have a cycle.
await import("../harness/agents");
let { documentTools } = await import("../agent/tools");
let Service = await import("../plan/service");
let { openPlan } = await import("./plan");

let manifestPath = process.argv[2];
let outputPath = process.argv[3];
let fence = process.argv[4] ?? "seecode";
if (!manifestPath || !outputPath || (fence !== "seecode" && fence !== "wireframe")) {
	throw new Error(
		"usage: bun seecode-assessment.ts DEVELOPMENT_REGISTRY OUTPUT_JSON [seecode|wireframe]",
	);
}
let invitation = fence === "wireframe"
	? `Sketch an interface the source describes in a wireframe fence only if it is
discussed concretely; never draw one as box-drawing or ASCII art.`
	: "Use an explanatory seecode diagram only if the source supports useful structure;";
let manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
	development: Array<{
		id: string;
		files: Array<{ path: string; checkpoint: string }>;
	}>;
};
let selected = [
	{ id: "astro-production-deps", checkpoint: "c2" },
	{ id: "vite-bundled-dev-hmr", checkpoint: "c2" },
	{ id: "biome-fix-all", checkpoint: "c1" },
];
let credential = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
let token = new TextDecoder().decode(credential.stdout).trim();
if (credential.exitCode !== 0 || !token) throw new Error("GitHub CLI credential unavailable");
let model = "gpt-6-luna";
let harness = createCopilotSdk({ credentials: () => token, model });
let results: Array<Record<string, unknown>> = [];

for (let selection of selected) {
	let entry = manifest.development.find(item => item.id === selection.id);
	let file = entry?.files.find(item => item.checkpoint === selection.checkpoint);
	if (!file) throw new Error(`Missing frozen checkpoint ${selection.id}/${selection.checkpoint}`);
	let snapshot = JSON.parse(await readFile(join(dirname(manifestPath), file.path), "utf8")) as {
		cutoff: string;
		events: Array<{
			kind?: string;
			type?: string;
			actor?: { login?: string; label?: string };
			body: string;
		}>;
	};
	let source = snapshot.events.map(event =>
		`[${event.kind ?? event.type}, ${
			event.actor?.login ?? event.actor?.label ?? "unknown"
		}] ${event.body}`
	).join("\n\n").slice(0, 18_000);
	let opened = await openPlan("# Source-grounded explanation\n");
	let documentRoom = {
		id: opened.channel.id,
		plan: opened.plan,
		server: opened.server,
		publish: (mutation: Room.Mutation) =>
			Service.publish(opened.plan, opened.server, opened.channel.id, mutation),
		persist: () => Service.persist(opened.plan),
		exclusive: <T>(action: () => Promise<T>) => Service.exclusive(opened.plan, action),
		anchors: () => {},
		changes: () => {},
	};
	let tools = { read_plan: documentTools.read_plan, edit_plan: documentTools.edit_plan };
	let agent = new HarnessAgent({
		harness,
		tools,
		toolsContext: {
			read_plan: { room: documentRoom },
			edit_plan: { room: documentRoom },
		},
		activeTools: ["read_plan", "edit_plan"],
		permissionMode: "allow-reads",
		callOptionsSchema: z.custom<typeof documentRoom>(),
		prepareCall: ({ options, ...rest }) => ({
			...rest,
			model,
			instructions: PROMPT
				+ "\n\nFor this frozen development assessment, use only read_plan and edit_plan. "
				+ "Repository tools and links are unavailable; do not infer later outcomes.",
			toolsContext: {
				read_plan: { room: options },
				edit_plan: { room: options },
			},
		}),
	});
	let session = await agent.createSession({
		sessionId: crypto.randomUUID(),
		sandboxSession: {
			defaultWorkingDirectory: "/tmp",
			async run(input: { env?: Record<string, string> }) {
				let directory = input.env?.WORK_DIR;
				if (!directory) return { exitCode: 1, stdout: "", stderr: "not available" };
				await mkdir(directory, { recursive: true });
				return { exitCode: 0, stdout: "", stderr: "" };
			},
			async destroy() {},
		} as never,
	});
	let started = performance.now();
	let calls: string[] = [];
	let trace: string[] = [];
	let usage: unknown;
	let failure: string | undefined;
	try {
		let turn = await agent.stream({
			session,
			prompt: `Write a short, provisional explanation using only this frozen discussion excerpt.
Its cutoff is ${snapshot.cutoff}. Links in the text are inert. Do not use later outcomes.
${invitation}
prose alone is a valid choice. Read the document, then edit it if warranted.\n\n${source}`,
			options: documentRoom,
			abortSignal: AbortSignal.timeout(180_000),
		});
		for await (let part of turn.fullStream) {
			if (part.type === "tool-call") calls.push(part.toolName);
			if (part.type === "tool-call" || part.type === "tool-result") {
				trace.push(JSON.stringify(part).slice(0, 4_000));
			}
			if (part.type === "finish-step") usage = part.usage;
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	} finally {
		await session.destroy();
	}
	await Service.close(opened.plan);
	let reopened = await Service.open(opened.channel.id, opened.backend, opened.server);
	let saved = Room.project(reopened.document);
	results.push({
		id: selection.id,
		checkpoint: selection.checkpoint,
		cutoff: snapshot.cutoff,
		model,
		elapsedMs: Math.round(performance.now() - started),
		calls,
		trace,
		usage,
		failure,
		saved,
		fenced: saved.includes(`\`\`\`${fence}`),
		// Box-drawing characters mean the model sketched an interface outside a validated fence.
		boxDrawing: [...saved].some(char => {
			let code = char.codePointAt(0)!;
			return code >= 0x2500 && code <= 0x257f;
		}),
	});
	await Service.close(reopened);
	console.log(
		`${selection.id}/${selection.checkpoint}: ${failure ?? "turn finished"}, ${calls.length} calls`,
	);
}
await Bun.write(outputPath, JSON.stringify({ model, fence, results }, null, 2));
await harness.shutdown();
