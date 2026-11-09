/**
 * Whether two answers of a JSON endpoint say the same thing, however their keys are ordered: the
 * test for a polled answer that changed nothing, which a store keeps instead of publishing, so
 * nothing that renders it renders again.
 */
export function sameJson(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	let keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every(key =>
		Object.hasOwn(b, key)
		&& sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
	);
}
