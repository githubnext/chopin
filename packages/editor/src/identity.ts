/**
 * The local awareness state carrying a new identity.
 *
 * Lexical stores name and colour beside the caret, focus flag and awareness
 * data. Replacing only a field leaves peers on the old identity until the next
 * renewal, so the whole state is rebuilt and published with `setLocalState`.
 * A null state (a closed tab) stays null: an identity change must not resurrect it.
 */
export function withIdentity<State extends { name: string; color: string }>(
	state: State | null,
	identity: { name: string; color: string },
): State | null {
	if (!state) return null;
	if (state.name === identity.name && state.color === identity.color) return state;
	return { ...state, name: identity.name, color: identity.color };
}
