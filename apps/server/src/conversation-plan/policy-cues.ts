export const OWNED_QUOTE_MIN = 0.7;
export const COMMA_ALTERNATIVES =
	/^[^,;?]{2,80}(?:,\s*[^,;?]{2,80})+(?:,\s*or\s+|\s+or\s+)[^,;?]{2,80}\??$/i;
export function directResolution(text: string): boolean {
	return /^\s*(?:and\s+)?(?:we(?: have|['’]ve)? decided|let['’]?s (?:just )?(?:make|do|use|choose|pick|go with)|we(?:'re| are) going with)\b/i
		.test(text)
		&& !/\b(?:please (?:show|quote|display)|said|told|claimed|reported|according to|apparently|seems?|i guess|maybe|perhaps|i prefer)\b/i
			.test(text)
		&& !/[🙄]/u.test(text);
}
export function directOwnedCommitment(text: string): boolean {
	return directResolution(text) && !text.trim().endsWith("?")
		&& !/\b(?:not|don't|do not|without|if|unless)\b/i.test(text);
}
export function directRecommendation(text: string): boolean {
	return /^\s*(?:and\s+)?(?:we\s+should|i\s+think\s+we\s+should)\s+(?:also\s+)?(?:do|use|choose|pick|go with|host|store|send)\b/i
		.test(text)
		&& !/\b(?:not|don't|do not|without|maybe|perhaps|probably|i guess|if|unless|said|asked)\b/i
			.test(text)
		&& !text.trim().endsWith("?");
}
export function directReopening(text: string): boolean {
	return /\b(?:reopen|reconsider|let's revisit|we should revisit)\b/i.test(text)
		&& !/\b(?:please (?:show|quote|display)|said|apparently)\b/i.test(text);
}

export function namesCardOption(quote: string, label: string): boolean {
	let escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(quote);
}

export function namesStanceOption(quote: string, label: string): boolean {
	if (namesCardOption(quote, label)) return true;
	if (label.length > 80) return false;
	let content =
		/^Start with (?:a|an|the) ([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*(?: [\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*){1,5})[.!?]?$/iu
			.exec(label)?.[1];
	return !!content
		&& ["a", "an", "the"].some(article => namesCardOption(quote, `${article} ${content}`));
}

export function immediateSpikeCondition(text: string, end: number): boolean {
	return /^\s*(?:[,;:]\s*)?(?:if|unless|provided(?:\s+that)?)(?=\s|$)/iu
		.test(text.slice(end, end + 160));
}
