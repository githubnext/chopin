import { asSchema } from "ai";

import type { Tool as AiTool } from "ai";
import type { Tool as CopilotTool } from "@github/copilot-sdk";

export function toCopilotTools(
	tools: Record<string, AiTool>,
	context: Record<string, unknown>,
): CopilotTool[] {
	return Object.entries(tools).map(([name, definition]) => {
		if (!definition.execute) throw new Error(`Tool ${name} is not executable`);
		let schema = asSchema(definition.inputSchema).jsonSchema;
		return {
			name,
			description: typeof definition.description === "function"
				? definition.description({ context })
				: definition.description ?? "",
			parameters: schema as CopilotTool["parameters"],
			skipPermission: definition.metadata?.skipPermission === true,
			handler: async (input, meta) => {
				let result = await definition.execute!(input, {
					context,
					toolCallId: meta.toolCallId,
					messages: [],
				});
				if (typeof result !== "string") throw new Error(`Tool ${name} did not return text`);
				return result;
			},
		};
	});
}
