import { useEffect, useRef } from "react";

import type { RefObject } from "react";
import type { Wire } from "./wire";

/**
 * Tells the server while this person has the document title open, in its header field or the
 * document's own heading, and whether they have typed in it: the Planner's drafted title then
 * waits rather than racing them.
 */
export function useTitlingReport(
	{ wire, room, open, area }: {
		wire: Wire | undefined;
		room: string;
		/** The header's title field is open. */
		open: boolean;
		/** Holds this document's live editor. */
		area: RefObject<HTMLElement | null>;
	},
) {
	let check = useRef<() => void>(undefined);
	let opened = useRef(open);
	opened.current = open;

	useEffect(() => {
		if (!wire) return;
		let live = true;
		// What the server last heard on this connection.
		let sent = { active: false, edited: false };
		let edited = false;
		let active = () => {
			if (opened.current) return true;
			let focused = document.activeElement;
			if (!focused) return false;
			if (focused.id === `document-title-${room}`) return true;
			let anchor = getSelection()?.anchorNode;
			let heading = (anchor instanceof Element ? anchor : anchor?.parentElement)
				?.closest("[data-document-title]");
			return !!heading && focused.contains(heading)
				&& !!area.current?.querySelector("[data-live-document]")?.contains(heading);
		};
		let report = (typed = false) => {
			if (!live) return;
			let now = active();
			if (typed && now) edited = true;
			if (sent.active === now && sent.edited === edited) return;
			sent = { active: now, edited };
			wire.send("plan:titling", { active: now, ...(edited ? { edited: true } : {}) });
		};
		let changed = () => report();
		let typed = () => report(true);
		// Blur lands before the next element takes focus.
		let left = () => setTimeout(changed);
		check.current = changed;
		// A reopened document is a new connection to the server, which knows nothing yet.
		let off = wire.on("plan:open", () => {
			sent = { active: false, edited: false };
			report();
		});
		document.addEventListener("selectionchange", changed);
		document.addEventListener("focusin", changed);
		document.addEventListener("focusout", left);
		document.addEventListener("input", typed, true);
		report();
		return () => {
			off();
			document.removeEventListener("selectionchange", changed);
			document.removeEventListener("focusin", changed);
			document.removeEventListener("focusout", left);
			document.removeEventListener("input", typed, true);
			if (check.current === changed) check.current = undefined;
			if (sent.active) wire.send("plan:titling", { active: false });
			live = false;
		};
	}, [wire, room]);

	useEffect(() => check.current?.(), [open]);
}
