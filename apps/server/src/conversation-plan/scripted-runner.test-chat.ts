import * as Chat from "../chat/service";
import { documentTools } from "../agent/tools";
import { jobTools, scopedJobTools } from "../agent/job-tools";

export type Room = Chat.Room;

// The historical runner calls handlers directly; this bridge exercises current tools, not a stream.
export function planTools(context: Room) {
	let room = Chat.documentRoom(context);
	let tools = scopedJobTools({
		edit_plan: documentTools.edit_plan,
		draft_heading: jobTools.draft_heading,
	}, room);
	return Object.entries(tools).map(([name, tool]) => ({
		name,
		handler: (input: unknown, _context: unknown) => {
			let execute = tool.execute;
			if (!execute) throw new Error(`no executable tool ${name}`);
			return execute(input as never, {
				toolCallId: `scripted:${name}`,
				messages: [],
				context: { room },
			});
		},
	}));
}
