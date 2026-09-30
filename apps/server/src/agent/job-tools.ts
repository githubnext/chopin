import { jsonSchema, tool } from "ai";
import { z } from "zod";
import { draftHeading } from "./heading-tool";
import { jobToolContext } from "./job-tool-context";
import { refusal, runJobTool } from "./job-scope";

import type { ToolSet } from "ai";
import type { DocumentRoom } from "./tools";

let contextSchema = z.object({
	room: z.custom<DocumentRoom>(value =>
		!!value && typeof value === "object"
		&& typeof (value as DocumentRoom).id === "string" && !!(value as DocumentRoom).plan
	),
});

export let jobTools = {
	draft_heading: tool({
		description: "Background job only. Give an empty document its title and one-paragraph "
			+ "goal, drawn from what people have said. Refused once the document has authored prose.",
		inputSchema: jsonSchema<{ revision: number; title: string; goal: string }>({
			type: "object",
			properties: {
				revision: { type: "integer", minimum: 0 },
				title: { type: "string", minLength: 1, maxLength: 80 },
				goal: { type: "string", minLength: 1, maxLength: 400 },
			},
			required: ["revision", "title", "goal"],
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
