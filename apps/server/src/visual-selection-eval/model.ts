import { HarnessAgent } from "@ai-sdk/harness/agent";
import { Output } from "ai";
import { z } from "zod";

import { harnessFor } from "../harness/harnesses";
import { openWorkerSession } from "../jobs/worker-session";
import { CHOICES } from "./catalogue";

import type { Choice } from "./catalogue";
import type { ModelAttempt } from "./experiment";

let output = z.object({
	choice: z.enum(CHOICES),
	specJson: z.string().max(20_000).nullable(),
	content: z.string().max(4_000),
	evidenceIds: z.array(z.string().max(240)).max(20),
	rationale: z.string().max(1_000),
}).strict();

export type ModelSettings = {
	harness: "copilot-sdk" | "pi" | "atomic";
	auth?: string;
	model: string;
	token?: string;
	timeoutMs: number;
};

/** Uses the supported harness with no tools and a fresh session for each attempt. */
export function modelGenerator(settings: ModelSettings) {
	let harness = harnessFor({ harness: settings.harness, harnessAuth: settings.auth });
	let agent = new HarnessAgent({
		harness,
		tools: {},
		activeTools: [],
		permissionMode: "allow-reads",
		output: Output.object({ schema: output }),
		callOptionsSchema: z.custom<{ model: string; instructions: string }>(),
		prepareCall: ({ options, ...rest }) => ({
			...rest,
			model: options.model,
			instructions: options.instructions,
		}),
	});
	return async (input: object, allowed: Choice[], instructions: string): Promise<ModelAttempt> => {
		let controller = new AbortController();
		let timer = setTimeout(() => controller.abort(), settings.timeoutMs);
		let aborted = new Promise<never>((_, reject) => {
			controller.signal.addEventListener("abort", () => reject(new Error("model timed out")), {
				once: true,
			});
		});
		let worker;
		let started = performance.now();
		try {
			worker = await openWorkerSession(agent, {
				token: () => settings.token,
				maxAiCredits: 1,
				aborted,
			});
			let result = await Promise.race([
				agent.generate({
					session: worker.session,
					prompt: JSON.stringify({ source: input, permittedChoices: allowed }),
					abortSignal: controller.signal,
					options: { model: settings.model, instructions },
				}),
				aborted,
			]);
			return {
				requestedModel: settings.model,
				latencyMs: Math.round(performance.now() - started),
				usage: result.usage ?? null,
				answer: output.parse(result.output),
			};
		} finally {
			clearTimeout(timer);
			await worker?.close();
		}
	};
}
