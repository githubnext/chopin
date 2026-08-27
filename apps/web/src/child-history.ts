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
