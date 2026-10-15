/** The smallest edit that preserves unchanged CRDT characters and their identities. */
export function textSplice(before: string, after: string) {
	if (before === after) return undefined;
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	if (start > 0 && /[\uDC00-\uDFFF]/u.test(before[start] ?? "")) start--;
	let end = before.length;
	let nextEnd = after.length;
	while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) {
		end--;
		nextEnd--;
	}
	if (end < before.length && /[\uDC00-\uDFFF]/u.test(before[end] ?? "")) {
		end++;
		nextEnd++;
	}
	return { start, remove: end - start, insert: after.slice(start, nextEnd) };
}
