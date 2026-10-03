import type { ConversationPlan } from "@chopin/protocol";

/** A question mention is provenance only when it is the card thread's exact saved ref. */
export function matchesQuestionSource(
	source: ConversationPlan.SourceRef,
	thread: ConversationPlan.Thread | undefined,
): boolean {
	return source.role === "question"
		&& !!thread?.questionSources.some(ref =>
			ref.role === "question" && ref.messageId === source.messageId
			&& ref.quote === source.quote && ref.start === source.start && ref.end === source.end
			&& ref.author.kind === source.author.kind
			&& (ref.author.kind !== "member" || source.author.kind === "member"
					&& ref.author.handle === source.author.handle)
		);
}

function words(value: string): string[] {
	return value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsWords(haystack: string[], part: string[]): boolean {
	return part.length > 0
		&& haystack.some((_, index) => part.every((word, offset) => haystack[index + offset] === word));
}

/** Match a named alternative as whole, adjacent words in the saved question quote. */
export function questionMentionsOption(quote: string, label: string): boolean {
	let mention = words(quote);
	let option = words(label);
	if (["use", "using", "choose"].includes(option[0] ?? "")) option.shift();
	if (option[0] === "host") {
		if (option[1] === "on") option.splice(0, 2);
		else {
			let on = option.indexOf("on", 2);
			let topicEnd = quote.indexOf(":");
			if (
				on > 1 && on <= 6 && topicEnd >= 0
				&& containsWords(words(quote.slice(0, topicEnd)), option.slice(1, on))
			) option.splice(0, on + 1);
		}
	}
	if (["a", "an", "the"].includes(option[0] ?? "")) option.shift();
	return containsWords(mention, option);
}
