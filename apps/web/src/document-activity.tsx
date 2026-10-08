/**
 * Whether the Planner is writing, or has written, document changes the reader
 * has not seen because another view (Decisions or Chat) is in front.
 *
 * Only agent edits count: the server sends `plan:changes` for Planner and MCP
 * edits, never for collaborators typing.
 */
export type DocumentActivityState = {
	/**
	 * The running turn is writing the document. `awaiting` means this viewer
	 * answered a decision out of view and the resumed turn has not started yet;
	 * it expires if no turn starts shortly, so an unrelated turn cannot inherit it.
	 */
	following?: "awaiting" | "active";
	/** Agent changes landed while the document was out of view. */
	unseen: boolean;
};

export type DocumentActivityEvent =
	| { type: "answered"; busy: boolean }
	| { type: "changes"; busy: boolean }
	| { type: "started" }
	| { type: "expired" }
	| { type: "seen" }
	| { type: "idle" };

export type DocumentActivity = "writing" | "unseen" | undefined;

export const QUIET_DOCUMENT: DocumentActivityState = { unseen: false };

/** How long an answer waits for the Planner's turn to resume before it is forgotten. */
export const ANSWER_FOLLOW_MS = 3_000;

/** Callers send `answered` and `changes` only while the document is out of view. */
export function advanceDocumentActivity(
	state: DocumentActivityState,
	event: DocumentActivityEvent,
): DocumentActivityState {
	let following = (next: DocumentActivityState["following"]) =>
		state.following === next ? state : { ...state, following: next };
	switch (event.type) {
		case "seen":
			return state.following || state.unseen ? QUIET_DOCUMENT : state;
		case "answered":
			return following(event.busy ? "active" : "awaiting");
		case "changes": {
			let next = event.busy ? following("active") : state;
			return next.unseen ? next : { ...next, unseen: true };
		}
		case "started":
			return state.following === "awaiting" ? following("active") : state;
		case "expired":
			return state.following === "awaiting" ? following(undefined) : state;
		case "idle":
			return state.following === "active" ? following(undefined) : state;
	}
}

export function documentActivity(
	state: DocumentActivityState,
	busy: boolean,
): DocumentActivity {
	if (busy && state.following === "active") return "writing";
	return state.unseen ? "unseen" : undefined;
}

export function documentActivityLabel(activity: DocumentActivity): string {
	if (activity === "writing") return "Document, Planner writing";
	if (activity === "unseen") return "Document, new changes";
	return "Document";
}

/**
 * A quiet petrol mark: a breathing ring while the Planner writes, a filled dot
 * once changes wait. `corner` sits in the button's padding so nothing shifts.
 */
export function DocumentActivityDot(
	{ activity, placement = "inline" }: {
		activity: DocumentActivity;
		placement?: "corner" | "inline";
	},
) {
	if (!activity) return null;
	return (
		<span
			aria-hidden="true"
			className={`document-activity-dot shrink-0 rounded-full ${
				activity === "writing" ? "size-2 border-2 border-brand" : "size-1.5 bg-brand"
			} ${placement === "corner" ? "absolute right-0 top-1" : "ml-1"}`}
			data-document-activity={activity}
		/>
	);
}
