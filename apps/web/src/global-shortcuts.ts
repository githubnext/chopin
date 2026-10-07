import { currentShortcutPlatform, matchShortcut } from "./shortcuts";

import type { ShortcutId } from "./shortcuts";

export type ShortcutActions = Partial<Record<ShortcutId, () => void>>;

const TYPING =
	"input, textarea, select, [contenteditable]:not([contenteditable='false']), [role=menu], [role=listbox]";

/** Listens on the window, after the editor and fields have had their chance to claim a key. */
export function listenForShortcuts(actions: () => ShortcutActions): () => void {
	let platform = currentShortcutPlatform();
	let keyDown = (event: KeyboardEvent) => {
		if (event.defaultPrevented || event.repeat) return;
		let target = event.target instanceof Element ? event.target : null;
		let id = matchShortcut(event, platform, {
			typing: !!target?.closest(TYPING),
			modal: [...document.querySelectorAll("[aria-modal='true']")].some(modal =>
				!modal.closest("[inert]")
			),
		});
		let action = id && actions()[id];
		if (!action) return;
		event.preventDefault();
		action();
	};
	window.addEventListener("keydown", keyDown);
	return () => window.removeEventListener("keydown", keyDown);
}
