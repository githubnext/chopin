import { jsonSchema, tool } from "ai";
import { MAX_TITLE_LENGTH } from "@chopin/dialect";
import { z } from "zod";
import { draftHeading } from "./heading-tool";
import { jobToolContext } from "./job-tool-context";
import { refusal, runJobTool } from "./job-scope";
import { createFollowupTools } from "./scoped-followup-tools";

import type { ToolSet } from "ai";
import type { DocumentRoom } from "./tools";

let contextSchema = z.object({
	room: z.custom<DocumentRoom>(value =>
		!!value && typeof value === "object"
		&& typeof (value as DocumentRoom).id === "string" && !!(value as DocumentRoom).plan
	),
});

export let jobTools = {
	...createFollowupTools(),
	draft_heading: tool({
		description: "Background job only. Maintain a short document title from saved conversation. "
			+ "Keep the current title when evidence is weak; a title a person chose is always kept. "
			+ "An optional goal only seeds an empty body.",
		inputSchema: jsonSchema<{ revision: number; title: string; goal?: string }>({
			type: "object",
			properties: {
				revision: { type: "integer", minimum: 0 },
				title: { type: "string", maxLength: MAX_TITLE_LENGTH },
				goal: { type: "string", minLength: 1, maxLength: 400 },
			},
			required: ["revision", "title"],
			additionalProperties: false,
		}),
		contextSchema,
		execute: async (raw, { context: { room } }): Promise<string> => {
			try {
				let turn = room.plan.chat.turn;
				let result = await runJobTool(
					room.plan.chat,
					"draft_heading",
					job => draftHeading(jobToolContext(room), job, turn, raw),
				);
				return JSON.stringify(result, null, 2) ?? "null";
			} catch (err) {
				let message = err instanceof Error ? err.message : String(err);
				console.error("[agent/draft_heading]", err);
				return `Error: ${message}`;
			}
		},
	}),
};

/** Check the live job at execution, even if a harness ignores its active tool list. */
export function scopedJobTools(tools: ToolSet, room: DocumentRoom): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, original]) => {
			let execute = original.execute;
			if (!execute) return [name, original];
			return [name, {
				...original,
				execute: (input, options) => {
					let denied = refusal(room.plan.chat?.job, name);
					if (denied) return Promise.resolve(`Error: ${denied}`);
					return execute(input, options);
				},
			}];
		}),
	);
}
