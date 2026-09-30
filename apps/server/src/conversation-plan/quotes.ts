import { assertQuoteBudget, MAX_QUOTE_CANDIDATES } from "./quote-budget";

/** Exact UTF-16 spans from the saved message. This path never invents wording. */
export type QuoteCandidate = { quote: string; start: number; end: number };

const DIRECT_DECISION_CLAUSE =
	/^(?:(?:(?:for|before|after|during|in|on|regarding|about)\b|as part of\b)[^.!?,]{1,100},\s*)?(?:we|i)\s+(?:need to|have to|should|must)\s+(?:decide|choose)\s*$/i;

/** Exact two-question structure, before judging whether the request is attributed. */
function compoundDecisionPrefix(
	text: string,
	candidates: readonly QuoteCandidate[],
): { prefix: string; context: string } | undefined {
	if (text.length > 500 || candidates.length !== 2) return;
	let [first, second] = candidates;
	if (!first || !second) return;
	if (
		![first.start, first.end, second.start, second.end].every(Number.isSafeInteger)
		|| first.start < 0 || first.end >= second.start || second.end > text.length
	) return;
	if (
		text.slice(first.start, first.end) !== first.quote
		|| text.slice(second.start, second.end) !== second.quote
	) return;
	if (first.quote.toLowerCase() === second.quote.toLowerCase()) return;
	let prefix = text.slice(0, first.start);
	let between = text.slice(first.end, second.start);
	let suffix = text.slice(second.end);
	if (
		!/\b(?:we|i)\s+(?:need to|have to|should|must)\s+(?:decide|choose)\s*$/i
			.test(prefix)
		|| !/^\s*,?\s*and\s+$/i.test(between)
		|| !/^[.!?]?\s*$/.test(suffix)
		|| !candidates.every(candidate => /^(?:how|what|which)\b[\s\S]{3,160}$/i.test(candidate.quote))
	) return;
	let sentenceStart =
		Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("!"), prefix.lastIndexOf("?")) + 1;
	let directPrefix = prefix.slice(sentenceStart);
	return { prefix: directPrefix, context: directPrefix + between + suffix };
}

/** A compound request lacking a direct decision clause from this speaker. */
export function isAttributedCompoundDecision(
	text: string,
	candidates: readonly QuoteCandidate[],
): boolean {
	let decision = compoundDecisionPrefix(text, candidates);
	return decision !== undefined && !DIRECT_DECISION_CLAUSE.test(decision.prefix.trim());
}

/** Two exact question spans introduced by one direct, speaker-owned decision request. */
export function isExplicitCompoundDecision(
	text: string,
	candidates: readonly QuoteCandidate[],
): boolean {
	let decision = compoundDecisionPrefix(text, candidates);
	return decision !== undefined && DIRECT_DECISION_CLAUSE.test(decision.prefix.trim())
		&& !/\b(?:according to|if|unless|maybe|perhaps|could|would)\b/i.test(decision.context)
		&& !/["“”‘’🙄]/u.test(decision.context);
}

const CLAUSE_BOUNDARY =
	/\s+and\s+(?=(?:remember|keep|show|ask|make|use|choose|save|reopen|compare|require|add|remove|start|offer|set|let|store|preview)\b)/gi;

const OPTION_CLAUSE_INTRODUCER =
	/\b(?:but|however|yet|because|since|as|although|though|whereas|while|if|unless)\b/i;

/** Closed-class clause heads cannot begin an atomic provider label. */
function startsWithClauseHead(quote: string): boolean {
	return /^(?:as|because|if|unless|when|while|since|although|though)\b/i.test(quote.trim());
}

/** Alternatives from a direct question, excluding reported or negated choices. */
export function directAlternativeQuotes(text: string): QuoteCandidate[] {
	let trimmed = text.trim();
	if (/\b(?:not|never|don't|shouldn['’]t|avoid)\b|🙄/iu.test(trimmed)) return [];
	let topicAlternatives = trimmed.length <= 500
		? trimmed.match(
			/^[Ww]hat sends [\p{L}][\p{L}-]{2,39}\s+[\p{L}][\p{L}-]{2,39}(?:\s+(?:when configured|as a fallback))?\?\s+our\s+([A-Z][\p{L}\p{N}.+#-]{1,39}(?:\s+[\p{L}\p{N}][\p{L}\p{N}.+#-]{1,39})?),\s+([A-Z][\p{L}\p{N}.+#-]{1,39}(?:\s+[\p{L}\p{N}][\p{L}\p{N}.+#-]{1,39})?),\s+or\s+([A-Z][\p{L}\p{N}.+#-]{1,39}(?:\s+[\p{L}\p{N}][\p{L}\p{N}.+#-]{1,39})?)\?$/u,
		)
		: null;
	if (topicAlternatives) {
		let labels = topicAlternatives.slice(1).map(label => label.trim().toLowerCase());
		if (new Set(labels).size !== 3 || labels.some(startsWithClauseHead)) return [];
	}
	if (!topicAlternatives && /[.!;]/.test(trimmed.slice(0, -1))) return [];
	if (
		/^Which\b/i.test(trimmed)
		&& /\b(?:did|does|do|said|say|asked|reported|according)\b/i.test(
			trimmed.slice(0, trimmed.indexOf(":")),
		)
	) return [];
	let match = topicAlternatives ?? trimmed.match(
		/^Should we\s+(use\s+[^,;?]+),\s*([^,;?]+),\s*or\s+([^,;?]+)\?$/i,
	) ?? trimmed.match(
		/^Should we\b[^?]{1,160}\b(?:in|on|at|via|with)\s+([^,;?]+?)\s+or\s+([^,;?]+)\?$/i,
	) ?? trimmed.match(
		/^Which\s+(?:[\w-]+\s+){1,4}should\s+[^?:]{1,120}:\s*([^,;?]+?)\s+or\s+([^,;?]+)\?$/i,
	)
		?? trimmed.match(/^Should\b[^?]{1,160}\b(?:use|go\s+in)\s+([^,;?]+?)\s+or\s+([^,;?]+)\?$/i);
	if (!match) return [];
	let result: QuoteCandidate[] = [];
	let offset = text.indexOf(trimmed);
	let searchFrom = 0;
	for (let raw of match.slice(1)) {
		if (/\bor\b/i.test(raw)) return [];
		let start = trimmed.indexOf(raw, searchFrom);
		if (start < 0) return [];
		let end = start + raw.length;
		while (/\s/.test(trimmed[start] ?? "")) start++;
		while (/\s/.test(trimmed[end - 1] ?? "")) end--;
		let opening = trimmed[start];
		let closing = trimmed[end - 1];
		if ((opening === '"' || closing === '"') && (opening !== '"' || closing !== '"')) {
			return [];
		}
		if ((opening === "“" || closing === "”") && (opening !== "“" || closing !== "”")) {
			return [];
		}
		if ((opening === '"' && closing === '"') || (opening === "“" && closing === "”")) {
			start++;
			end--;
		}
		if (start >= end) return [];
		result.push({
			quote: text.slice(offset + start, offset + end),
			start: offset + start,
			end: offset + end,
		});
		searchFrom = end;
	}
	return result;
}

/** A bounded, first-person explanation of two alternatives for a named topic. */
export function declarativeAlternativeQuotes(text: string): QuoteCandidate[] {
	if (text.length > 500) return [];
	let match = text.trim().match(
		/^By\s+[\w-]+(?:\s+[\w-]+){0,8}\s+I mean\s+([^,;.!?]{2,100}?)\s+or\s+([^,;.!?]{2,100})\.$/i,
	);
	if (!match) return [];
	let labels = match.slice(1).map(label => label.trim());
	if (
		labels.some(label =>
			/\b(?:or|not|never|don't|didn't|wouldn't|maybe|perhaps|actually)\b|['"“”‘’]/i.test(label)
		) || labels[0]!.toLowerCase() === labels[1]!.toLowerCase()
	) return [];
	let result: QuoteCandidate[] = [];
	let searchFrom = text.toLowerCase().indexOf("i mean") + "i mean".length;
	for (let label of labels) {
		let start = text.indexOf(label, searchFrom);
		if (start < 0) return [];
		let end = start + label.length;
		result.push({ quote: text.slice(start, end), start, end });
		searchFrom = end;
	}
	return result;
}

/** Exact labels from a speaker-owned, explicit three-way choice. */
export function multiAlternativeQuotes(text: string): QuoteCandidate[] {
	if (text.length > 500) return [];
	let prefix = text.match(
		/^\s*(?:(?:We|I)\s+(?:could|can|might|should)\s+(?:do|use|choose|try|go with)|By\s+[\w-]+(?:\s+[\w-]+){0,8}\s+I mean)\s+/i,
	);
	if (!prefix) return [];
	let bodyStart = prefix[0].length;
	let bodyEnd = text.trimEnd().length;
	if (/[.!?]$/.test(text.slice(0, bodyEnd))) bodyEnd--;
	let body = text.slice(bodyStart, bodyEnd);
	if (
		/[.!?;:'"“”‘’]/u.test(body)
		|| /\b(?:not|never|don't|wouldn't|instead|none)\b/i.test(body)
		|| OPTION_CLAUSE_INTRODUCER.test(body)
	) {
		return [];
	}
	let context = body.match(/\s+for\s+[\p{L}\p{N}\s/-]{2,100}$/u);
	if (context) bodyEnd -= context[0].length;
	let choices = text.slice(bodyStart, bodyEnd);
	let separators = [...choices.matchAll(/\s+or\s+|,\s*(?:or\s+)?/gi)];
	if (separators.length !== 2 || !/\bor\b/i.test(separators[1]![0])) return [];
	let spans: QuoteCandidate[] = [];
	let start = bodyStart;
	for (let separator of separators) {
		let end = bodyStart + separator.index;
		spans.push({ quote: text.slice(start, end), start, end });
		start = end + separator[0].length;
	}
	spans.push({ quote: text.slice(start, bodyEnd), start, end: bodyEnd });
	if (
		spans.some(({ quote }) =>
			quote.length < 2 || quote.length > 80 || quote.split(/\s+/).length > 6
			|| !/^[\p{L}\p{N}][\p{L}\p{N}\s+&/.#-]*$/u.test(quote)
			|| /\b(?:and|or|not|never|don't)\b/i.test(quote)
		)
	) return [];
	if (new Set(spans.map(({ quote }) => quote.toLowerCase())).size !== 3) return [];
	return spans;
}

/** A bare editor list whose final native-editor alternative contains its own "and". */
export function bareEditorOptionQuotes(text: string): QuoteCandidate[] {
	if (text.length > 500) return [];
	let match = text.match(
		/^([\p{L}][\p{L}\p{N}.+/-]{1,39}), (bare [\p{L}][\p{L}\p{N}.+/-]{1,39}), ([\p{L}][\p{L}\p{N}.+/-]{1,39}), or (just native Selection and Range with our own document model)\.$/iu,
	);
	if (!match) return [];
	let labels = match.slice(1);
	let names = labels.map(label => label.replace(/^bare\s+/i, "").toLowerCase());
	if (new Set(names).size !== 4) return [];
	let spans: QuoteCandidate[] = [];
	let searchFrom = 0;
	for (let label of labels) {
		let start = text.indexOf(label, searchFrom);
		if (start < 0) return [];
		let end = start + label.length;
		spans.push({ quote: text.slice(start, end), start, end });
		searchFrom = end;
	}
	return spans;
}

export function isBareEditorOptionList(
	text: string,
	candidates: readonly QuoteCandidate[],
): boolean {
	let exact = bareEditorOptionQuotes(text);
	return exact.length === 4 && candidates.length === 4
		&& exact.every((quote, index) =>
			quote.quote === candidates[index]?.quote
			&& quote.start === candidates[index]?.start
			&& quote.end === candidates[index]?.end
		);
}

/** Explicitly scoped decisions can contain multiple independent atomic spans. */
function scopedDecisionQuotes(text: string): QuoteCandidate[] {
	if (text.length > 500 || /["“”]|\b(?:not|never|reject(?:ed)?|dismissed)\b/i.test(text)) {
		return [];
	}
	let question = text.match(
		/^.{0,100}\bwe need to (?:choose|decide)\s+(how [^.!?;]{3,100}?)\s+and\s+(how [^.!?;]{3,100})\.\s*$/i,
	);
	let alternatives = text.match(
		/^\s*For [^.!?;]{3,100}, the options are ([^.!?;]{2,80}?) or ([^.!?;]{2,80})\.\s+Separately, for [^.!?;]{3,100}, we could (?:pass|use) ([^.!?;]{2,100}?) or (?:use|pass) (?:a |an |the )?([^.!?;]{2,100})\.(?:\s+[^.!?;]{1,80}\.)?\s*$/i,
	);
	let labels = question?.slice(1) ?? alternatives?.slice(1);
	if (
		!labels
		|| labels.some(label =>
			/\bor\b|\b(?:not|never|reject(?:ed)?|dismissed)\b|["“”]/i.test(label)
			|| alternatives !== null && label.split(/\s+/).length > 6
		)
	) return [];
	let spans: QuoteCandidate[] = [];
	let searchFrom = 0;
	for (let label of labels) {
		let start = text.indexOf(label, searchFrom);
		if (start < 0) return [];
		let end = start + label.length;
		spans.push({ quote: text.slice(start, end), start, end });
		searchFrom = end;
	}
	return spans;
}

export function extractQuotes(text: string): QuoteCandidate[] {
	let scoped = scopedDecisionQuotes(text);
	if (scoped.length) return scoped;
	let direct = directAlternativeQuotes(text);
	if (direct.length === 3) return direct;
	let bareEditor = bareEditorOptionQuotes(text);
	if (bareEditor.length) return bareEditor;
	let multi = multiAlternativeQuotes(text);
	if (multi.length) return multi;
	let declarative = declarativeAlternativeQuotes(text);
	if (declarative.length) return declarative;
	let candidates: QuoteCandidate[] = [];
	let append = (start: number, end: number): void => {
		let raw = text.slice(start, end);
		let left = raw.length - raw.trimStart().length;
		let right = raw.trimEnd().length;
		start += left;
		end = start + right - left;
		if (end > start && end - start <= 2048) {
			candidates.push({ quote: text.slice(start, end), start, end });
			assertQuoteBudget(candidates);
		}
	};
	let segment = (start: number, end: number): void => {
		let content = text.slice(start, end);
		let alternatives = directAlternativeQuotes(content);
		if (alternatives.length) {
			if (candidates.length + alternatives.length > MAX_QUOTE_CANDIDATES) {
				throw new Error(`source quote count exceeds ${MAX_QUOTE_CANDIDATES}`);
			}
			for (let alternative of alternatives) {
				append(start + alternative.start, start + alternative.end);
			}
			return;
		}
		let begin = start;
		for (let match of content.matchAll(CLAUSE_BOUNDARY)) {
			let split = start + match.index;
			let left = text.slice(begin, split).trim();
			let shortAssent = /^(?:yes|yeah|yep|sure|okay|ok|agreed|i agree|sounds good)[,!]?$/i
				.test(left);
			if (left.split(/\s+/).length < 3 && !shortAssent) continue;
			append(begin, split);
			begin = split + match[0].length;
		}
		append(begin, end);
	};
	let begin = 0;
	let boundaries = /[;.!?](?=\s|$)/g;
	for (let match of text.matchAll(boundaries)) {
		segment(begin, match.index + match[0].length);
		begin = match.index + match[0].length;
	}
	segment(begin, text.length);
	return candidates;
}
