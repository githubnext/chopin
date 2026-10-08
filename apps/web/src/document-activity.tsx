/**
 * Whether the Planner is writing, or has written, document changes the reader
 * has not seen because another view (Decisions or Chat) is in front.
 */
export type DocumentActivityState = {
	/** A decision was answered out of view, so the resumed turn is likely writing. */
	following: boolean;
	/** Planner changes landed while the document was out of view. */
	unseen: boolean;
};

export type DocumentActivityEvent =
	| { type: "answered" }
	| { type: "changes" }
	| { type: "seen" }
	| { type: "idle" };

export type DocumentActivity = "writing" | "unseen" | undefined;

export const QUIET_DOCUMENT: DocumentActivityState = { following: false, unseen: false };

/** Callers send `answered` and `changes` only while the document is out of view. */
export function advanceDocumentActivity(
	state: DocumentActivityState,
	event: DocumentActivityEvent,
): DocumentActivityState {
	if (event.type === "seen") {
		return state.following || state.unseen ? QUIET_DOCUMENT : state;
	}
	if (event.type === "answered") return state.following ? state : { ...state, following: true };
	if (event.type === "changes") return state.unseen ? state : { ...state, unseen: true };
	return state.following ? { ...state, following: false } : state;
}

export function documentActivity(
	state: DocumentActivityState,
	busy: boolean,
): DocumentActivity {
	if (busy && (state.following || state.unseen)) return "writing";
	return state.unseen ? "unseen" : undefined;
}

export function documentActivityLabel(activity: DocumentActivity): string {
	if (activity === "writing") return "Document, Planner writing";
	if (activity === "unseen") return "Document, new changes";
	return "Document";
}

/** A quiet petrol dot: breathing while the Planner writes, still once changes wait. */
export function DocumentActivityDot({ activity }: { activity: DocumentActivity }) {
	if (!activity) return null;
	return (
		<span
			aria-hidden="true"
			className="document-activity-dot ml-1 size-1.5 shrink-0 rounded-full bg-brand"
			data-document-activity={activity}
		/>
	);
}
