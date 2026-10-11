import { useEffect, useState } from "react";

/** Whether focus is in this room's document editor, so routing can leave the reader alone. */
export function useDocumentEditing(room: string): boolean {
	let [editing, setEditing] = useState(false);
	useEffect(() => {
		let selector = `[data-workspace-room="${CSS.escape(room)}"] [data-document-view="plan"] `
			+ `[contenteditable="true"]`;
		let read = () => setEditing(!!document.activeElement?.closest(selector));
		// activeElement is still the old element during focusout; read after it moves.
		let blur = () => queueMicrotask(read);
		read();
		document.addEventListener("focusin", read);
		document.addEventListener("focusout", blur);
		return () => {
			document.removeEventListener("focusin", read);
			document.removeEventListener("focusout", blur);
		};
	}, [room]);
	return editing;
}
