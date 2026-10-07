/** Why a document's header title opens as a field: a new name leads into the body. */
export type TitleEdit = "rename" | "new";

export const TITLE_EDIT_EVENT = "title-edit";

/** Pending requests by document; the workspace claims its own when it mounts or hears the event. */
export let titleEdits = new Map<string, TitleEdit>();

/** Opens a document's header title for editing now, or when its workspace next mounts. */
export function requestTitleEdit(id: string, edit: TitleEdit) {
	titleEdits.set(id, edit);
	// A document that never opens must not ambush a much later visit.
	setTimeout(() => titleEdits.delete(id), 15_000);
	dispatchEvent(new CustomEvent(TITLE_EDIT_EVENT, { detail: id }));
}
