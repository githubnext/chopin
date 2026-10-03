import { jobTools } from "./job-tools";
import type { DocumentRoom } from "./tools";

type ArchivedContext = Omit<DocumentRoom, "id"> & { room: string };

/** The archived callbacks use the old handler shape; execute the current tool unchanged. */
export function toolbox(context: ArchivedContext) {
	let room = { ...context, id: context.room };
	return [{
		name: "draft_heading",
		handler: (raw: unknown, _options: never) =>
			jobTools.draft_heading.execute!(raw as never, {
				context: { room },
				toolCallId: "heading-test",
				messages: [],
			}),
	}];
}
