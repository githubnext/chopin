import type { Chat } from "@chopin/protocol";
import type { StoredChatAttachment } from "../storage/model";

/** What Chat shows of a stored file: its identity and look, never its bytes. */
export function wireAttachment(
	value: Pick<StoredChatAttachment, "id" | "name" | "kind" | "mimeType" | "size">,
): Chat.Attachment {
	return {
		id: value.id,
		name: value.name,
		kind: value.kind,
		mimeType: value.mimeType,
		size: value.size,
	};
}
