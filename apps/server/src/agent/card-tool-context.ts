import { jobToolContext } from "./job-tool-context";
import type { Context as JobContext } from "./job-tool-context";
import type { DocumentRoom } from "./tools";

export type Context = JobContext & { currentMemberRequest?: () => { text: string } | undefined };
export type CardToolRoom = DocumentRoom & Pick<Context, "currentMemberRequest">;

export function cardToolContext(room: CardToolRoom): Context {
	return { ...jobToolContext(room), currentMemberRequest: room.currentMemberRequest };
}
