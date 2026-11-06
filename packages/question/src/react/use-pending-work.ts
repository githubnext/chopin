import { trackPendingWork } from "@chopin/protocol/pending-work";
import { useEffect } from "react";

/**
 * Count this component's work as unsaved, such as a message not yet sent, while `unsaved`
 * holds, so that a page about to reload for a new build waits for it.
 */
export function usePendingWork(unsaved: boolean): void {
	useEffect(() => {
		if (!unsaved) return;
		let source = { unsaved: true };
		trackPendingWork(source);
		return () => {
			source.unsaved = false;
		};
	}, [unsaved]);
}
