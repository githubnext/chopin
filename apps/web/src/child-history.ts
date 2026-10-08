import type { ResearchOpener } from "@chopin/editor";

export type ChildFocusToken = { generation: number; parentId: string };

export type ChildFocusAttempt = ChildFocusToken & {
	opener?: ResearchOpener;
	parentPath: string;
	phase: "closing" | "deferred";
};

export type ChildFocusState = {
	generation: number;
	attempt?: ChildFocusAttempt;
};

export type ChildFocusEvent =
	| {
		type: "begin";
		opener?: ResearchOpener;
		parentId: string;
		parentPath: string;
	}
	| { type: "route"; pathname: string }
	| { type: "restore" | "finish"; token: ChildFocusToken }
	| { type: "cancel" };

export function childFocusTransition(
	state: ChildFocusState,
	event: ChildFocusEvent,
): ChildFocusState {
	if (event.type === "begin") {
		if (
			state.attempt?.phase === "closing"
			&& state.attempt.parentId === event.parentId
			&& state.attempt.parentPath === event.parentPath
		) return state;
		let generation = state.generation + 1;
		return {
			generation,
			attempt: {
				generation,
				opener: event.opener,
				parentId: event.parentId,
				parentPath: event.parentPath,
				phase: "closing",
			},
		};
	}
	let attempt = state.attempt;
	if (!attempt) return state;
	if (event.type === "route") {
		return event.pathname === attempt.parentPath
			? state
			: { generation: state.generation + 1 };
	}
	if (event.type === "cancel") return { generation: state.generation + 1 };
	if (
		event.token.generation !== attempt.generation
		|| event.token.parentId !== attempt.parentId
	) return state;
	if (event.type === "finish") return { generation: state.generation };
	if (attempt.phase === "deferred") return state;
	return { ...state, attempt: { ...attempt, phase: "deferred" } };
}

export function childHistoryState(state: unknown, parent: string): Record<string, unknown> {
	return {
		...(typeof state === "object" && state !== null ? state : {}),
		chopinChildParent: parent,
	};
}

export function childCloseAction(
	state: unknown,
	parent: string,
): { type: "back" } | { type: "replace"; destination: string } {
	if (
		typeof state === "object" && state !== null
		&& "chopinChildParent" in state
		&& typeof state.chopinChildParent === "string"
	) {
		let markedParent = new URL(state.chopinChildParent, "http://chopin.local");
		if (markedParent.pathname === parent) return { type: "back" };
	}
	return { type: "replace", destination: parent };
}
