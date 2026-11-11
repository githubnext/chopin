import { MessageIcon } from "@chopin/icons";

/**
 * Small entry point on a Chat message to open or start its thread.
 * Kept behind one boundary so `message-actions` replaces it with the toolbar's
 * Reply in thread action when that branch lands.
 */
export function ThreadEntryButton(
	{ onOpen, rootId }: {
		rootId: string;
		onOpen: (rootId: string) => void;
	},
) {
	return (
		<button
			aria-label="Reply in thread"
			className="chat-thread-trigger btn btn-icon-xs btn-ghost shrink-0"
			data-thread-trigger={rootId}
			data-tooltip="Reply in thread"
			onClick={() => onOpen(rootId)}
			title="Reply in thread"
			type="button"
		>
			<MessageIcon aria-hidden="true" />
		</button>
	);
}
