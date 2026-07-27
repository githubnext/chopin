/**
 * Asking for a URL.
 *
 * Checking what comes back is not politeness. An address the dialect rejects
 * would apply locally, sync cleanly, then fail validation on the server —
 * which cannot undo a Yjs transaction and so rebuilds the room's epoch,
 * costing everyone present their undo history. The cheapest place to catch it
 * is before it becomes a node.
 */

export type UrlRules = {
	protocols: readonly string[];
	/**
	 * Whether a value with no protocol is acceptable.
	 *
	 * True for links, where a repository-relative path is meaningful. False for
	 * images, which have nothing to resolve against.
	 */
	relative: boolean;
};

export function acceptable(value: string, rules: UrlRules): boolean {
	if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return rules.relative;
	try {
		return rules.protocols.includes(new URL(value).protocol);
	} catch {
		return false;
	}
}

/**
 * Prompt, validate, and complain rather than silently dropping the input.
 *
 * Returns `undefined` when there is nothing to apply, and `null` when the
 * author deliberately cleared the field — a distinction links need and images
 * do not.
 */
export function askForUrl(label: string, rules: UrlRules): string | null | undefined {
	let entered = window.prompt(label);
	if (entered === null) return undefined;

	let value = entered.trim();
	if (!value) return null;

	if (!acceptable(value, rules)) {
		let allowed = [...rules.protocols, ...rules.relative ? ["relative paths"] : []];
		window.alert(`Only ${allowed.join(", ")} are allowed here.`);
		return undefined;
	}

	return value;
}
