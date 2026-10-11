/**
 * Reading and editing on a phone.
 *
 * A phone holds a document the way a reader does until its writer asks to edit: tapping prose
 * selects or follows links instead of raising the keyboard. This is a local choice, never synced,
 * and separate from permission: a viewer is read-only whatever this says, and a reader who may
 * write can still select and comment, which a permission lock does not allow.
 */

/** How this client holds a document. `undefined` means the surface has no reading mode. */
export type EditMode = "reading" | "editing";

/** Phones read until asked to edit. Elsewhere, and for anyone who cannot write, there is no mode. */
export function documentEditMode(
	{ canEdit, editing, phone }: { canEdit: boolean; editing: boolean; phone: boolean },
): EditMode | undefined {
	if (!phone || !canEdit) return undefined;
	return editing ? "editing" : "reading";
}

/** Whether a document should open straight into editing: there is nothing yet to read. */
export function opensEditing(
	{ empty, renaming }: { empty?: boolean; renaming?: boolean },
): boolean {
	return !!renaming || !!empty;
}

/**
 * What a non-collapsed selection offers.
 *
 * `locked` is every reason the editor cannot be edited except reading mode itself: a permission,
 * an agent turn, a lost connection, or a document that has not arrived. Reading keeps commenting;
 * a docked formatting toolbar takes over formatting while editing on a phone.
 */
export function selectionOffer(
	{ docked, locked, mode }: { docked: boolean; locked: boolean; mode?: EditMode },
): "none" | "comment" | "format" {
	if (locked) return "none";
	if (mode === "reading") return "comment";
	if (mode === "editing" && docked) return "none";
	return "format";
}
