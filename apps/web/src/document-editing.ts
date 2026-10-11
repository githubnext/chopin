import { useEffect, useState } from "react";

/** Whether focus is in this room's document editor, so routing can leave the reader alone. */
export function useDocumentEditing(room: string): boolean {
	let [editing, setEditing] = useState(false);
	useEffect(() => {
		// An open child's editor sits inside the parent's workspace but is not this document.
		let selector = `[data-workspace-room="${CSS.escape(room)}"] [data-document-view="plan"] `
			+ `[contenteditable="true"]:not(.workspace-child-slot *)`;
		let inEditor = (target: EventTarget | null) =>
			target instanceof Element && !!target.closest(selector);
		let focus = (event: FocusEvent) => setEditing(inEditor(event.target));
		// During focusout activeElement is not yet the new target; relatedTarget is.
		let blur = (event: FocusEvent) => {
			// The window losing focus keeps the editor's focus for when it returns.
			if (event.relatedTarget === null && !document.hasFocus()) return;
			setEditing(inEditor(event.relatedTarget));
		};
		setEditing(inEditor(document.activeElement));
		document.addEventListener("focusin", focus);
		document.addEventListener("focusout", blur);
		return () => {
			document.removeEventListener("focusin", focus);
			document.removeEventListener("focusout", blur);
		};
	}, [room]);
	return editing;
}
