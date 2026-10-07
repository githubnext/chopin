/** Why a document's header title opens as a field: a new name leads into the body. */
export type TitleEdit = "rename" | "new";

export const TITLE_EDIT_EVENT = "chopin:title-edit";

let requests = new Map<string, TitleEdit>();

/** Opens a document's header title for editing now, or when its workspace next mounts. */
export function requestTitleEdit(id: string, edit: TitleEdit) {
	requests.set(id, edit);
	// A document that never opens must not ambush a much later visit.
	setTimeout(() => requests.delete(id), 15_000);
	dispatchEvent(new CustomEvent(TITLE_EDIT_EVENT, { detail: id }));
}

export function claimTitleEdit(id: string): TitleEdit | undefined {
	let edit = requests.get(id);
	// StrictMode renders twice in one task, and both renders must see the claim.
	if (edit) queueMicrotask(() => requests.delete(id));
	return edit;
}
