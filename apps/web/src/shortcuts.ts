/**
 * The one registry of Chopin's keyboard shortcuts. Handlers, tooltip hints, menus,
 * and the shortcuts sheet all read from here so a chord is never described in two places.
 */

export type ShortcutPlatform = "mac" | "other";

export type ShortcutId =
	| "search"
	| "new-document"
	| "toggle-sidebar"
	| "toggle-chat"
	| "shortcuts"
	| "bold"
	| "italic"
	| "link"
	| "undo"
	| "redo";

export type Shortcut = {
	id: ShortcutId;
	label: string;
	group: "General" | "Editing";
	key: string;
	/** ⌘ on a Mac, Ctrl elsewhere. */
	mod?: boolean;
	shift?: boolean;
	/** Physical key, so a chord still matches on layouts that type another character. */
	code?: string;
	/** Listed in the sheet only; the editor owns the key. */
	display?: boolean;
};

export const SHORTCUTS: readonly Shortcut[] = [
	{ id: "search", label: "Search documents", group: "General", key: "k", mod: true },
	{ id: "new-document", label: "New document", group: "General", key: "c" },
	{
		id: "toggle-sidebar",
		label: "Show or hide sidebar",
		group: "General",
		key: "\\",
		code: "Backslash",
		mod: true,
	},
	{
		id: "toggle-chat",
		label: "Show or hide chat",
		group: "General",
		key: ".",
		code: "Period",
		mod: true,
	},
	{ id: "shortcuts", label: "Keyboard shortcuts", group: "General", key: "?" },
	{ id: "bold", label: "Bold", group: "Editing", key: "b", mod: true, display: true },
	{ id: "italic", label: "Italic", group: "Editing", key: "i", mod: true, display: true },
	{ id: "link", label: "Link selected text", group: "Editing", key: "k", mod: true, display: true },
	{ id: "undo", label: "Undo", group: "Editing", key: "z", mod: true, display: true },
	{ id: "redo", label: "Redo", group: "Editing", key: "z", mod: true, shift: true, display: true },
];

export function shortcutPlatform(userAgent: string): ShortcutPlatform {
	return /Mac|iPhone|iPad|iPod/.test(userAgent) ? "mac" : "other";
}

export function currentShortcutPlatform(): ShortcutPlatform {
	return typeof navigator === "undefined" ? "other" : shortcutPlatform(navigator.userAgent);
}

function shortcut(id: ShortcutId): Shortcut {
	return SHORTCUTS.find(entry => entry.id === id)!;
}

function keyName(key: string): string {
	return key.length === 1 ? key.toUpperCase() : key;
}

/** The separate keys of a chord, as printed on keycaps. */
export function shortcutKeys(id: ShortcutId, platform: ShortcutPlatform): string[] {
	let entry = shortcut(id);
	let keys: string[] = [];
	if (entry.mod) keys.push(platform === "mac" ? "⌘" : "Ctrl");
	if (entry.shift) keys.push(platform === "mac" ? "⇧" : "Shift");
	keys.push(keyName(entry.key));
	return keys;
}

/** A chord as one string: `⌘K` on a Mac, `Ctrl+K` elsewhere. */
export function shortcutLabel(id: ShortcutId, platform: ShortcutPlatform): string {
	return shortcutKeys(id, platform).join(platform === "mac" ? "" : "+");
}

export type ShortcutKey = {
	key: string;
	code?: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	isComposing?: boolean;
};

export type ShortcutContext = {
	/** Focus is in a text field, contenteditable, or a menu with its own keys. */
	typing: boolean;
	/** A modal dialog or drawer owns the keyboard. */
	modal: boolean;
};

/**
 * Single keys never fire while typing. Chords fire anywhere because the editor and
 * fields leave them alone. A chord the editor claims is prevented before it reaches
 * the window, and the caller skips prevented events.
 */
export function matchShortcut(
	event: ShortcutKey,
	platform: ShortcutPlatform,
	context: ShortcutContext,
): ShortcutId | undefined {
	if (event.isComposing || event.altKey || context.modal) return;
	let mod = platform === "mac" ? event.metaKey : event.ctrlKey;
	let other = platform === "mac" ? event.ctrlKey : event.metaKey;
	if (other) return;
	let key = event.key.toLowerCase();
	for (let entry of SHORTCUTS) {
		if (entry.display || !!entry.mod !== mod) continue;
		if (!entry.mod && context.typing) continue;
		// `?` is a shifted key on most layouts, so its own character is the match.
		if (entry.key === "?") {
			if (key === "?") return entry.id;
			continue;
		}
		if (!!entry.shift !== event.shiftKey) continue;
		if (key === entry.key || (entry.code !== undefined && event.code === entry.code)) {
			return entry.id;
		}
	}
	return;
}
