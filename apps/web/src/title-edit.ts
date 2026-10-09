/** Why a document's header title opens as a field: a new name leads into the body. */
export type TitleEdit = "rename" | "new";

/** Pending requests by document; the workspace claims its own when it mounts or hears the event. */
export let titleEdits = new Map<string, TitleEdit>();

/** Opens a document's header title for editing now, or when its workspace next mounts. */
export function requestTitleEdit(id: string, edit: TitleEdit) {
	titleEdits.set(id, edit);
	// A document that never opens must not ambush a much later visit.
	setTimeout(() => titleEdits.delete(id), 15_000);
	dispatchEvent(new CustomEvent("title-edit", { detail: id }));
}

/** Typing held from New document until the new title field takes it over. */
export let heldTyping: { text: string; enter?: boolean } | undefined;

// Keys pressed while a new document opens would land on the page or its body instead.
function hold(event: KeyboardEvent) {
	if (
		!heldTyping || event.metaKey || event.ctrlKey || event.altKey || event.isComposing
		|| (event.target as Element).matches("input,textarea")
	) return;
	if (event.key == "Enter") heldTyping.enter = true;
	else if (event.key.length == 1) heldTyping.text += event.key;
	else return;
	event.preventDefault();
}

export function holdTyping(on: boolean) {
	heldTyping = on ? { text: "" } : undefined;
	(on ? addEventListener : removeEventListener)("keydown", hold, true);
}
