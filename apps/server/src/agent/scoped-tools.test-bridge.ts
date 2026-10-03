import { createScopedTools } from "./scoped-tools";
import { documentTools } from "./tools";
import type { CardToolRoom, Context } from "./card-tool-context";
import type { ToolSet } from "ai";

type ArchivedContext = Omit<CardToolRoom, "id" | "currentMemberRequest"> & {
	room: string;
	currentMemberRequest?: Context["currentMemberRequest"];
};

/** Executes current AI SDK tools for the unchanged archived test callbacks. */
export function toolbox(context: ArchivedContext) {
	let room = { ...context, id: context.room };
	let tools: ToolSet = { ...documentTools, ...createScopedTools() };
	return Object.entries(tools).map(([name, value]) => ({
		name,
		skipPermission: value.metadata?.skipPermission === true,
		handler: (raw: unknown, _options: never) =>
			value.execute!(raw as never, {
				context: { room: room as CardToolRoom },
				toolCallId: "scoped-test",
				messages: [],
			}),
	}));
}
