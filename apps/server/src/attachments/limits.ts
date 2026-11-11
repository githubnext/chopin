import { MAX_LINK_ATTACHMENT_BYTES } from "@chopin/agent-link";

import type { AttachmentLimits } from "@chopin/protocol/attachment";

/**
 * The caps a message is held to now, or none where the server takes no files (a count of 0).
 * Under `HARNESS=remote` a turn's files travel inside one agent connection message, so the
 * per-file and total caps are never more than what that message can carry.
 */
export function attachmentLimits(
	config: { harness: string; chatAttachments: AttachmentLimits },
): AttachmentLimits | undefined {
	let { maxBytes, maxCount, maxTotalBytes } = config.chatAttachments;
	if (maxCount === 0) return undefined;
	if (config.harness !== "remote") return { maxBytes, maxCount, maxTotalBytes };
	return {
		maxBytes: Math.min(maxBytes, MAX_LINK_ATTACHMENT_BYTES),
		maxCount,
		maxTotalBytes: Math.min(maxTotalBytes, MAX_LINK_ATTACHMENT_BYTES),
	};
}
