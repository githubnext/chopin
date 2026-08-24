import { addressed, MENTION } from "@chopin/protocol/address";

import type { Chat } from "@chopin/protocol";

export const MAX_REFERENCES = 10;
export const MAX_REFERENCE_QUERY = 64;

export type ReferenceKind = Chat.ReferenceRequest["kind"];

export type ReferenceTrigger = {
	kind: ReferenceKind;
	marker: "#" | "%";
	query: string;
	start: number;
	end: number;
};

export type ReferenceTarget =
	| { kind: "document"; channelId: string; title: string; slug?: string; description?: string }
	| { kind: "research"; workspaceId: string; title: string; discriminator: string };

export type ReferenceDraft =
	| (Extract<Chat.ReferenceRequest, { kind: "document" }> & { token: string })
	| (Extract<Chat.ReferenceRequest, { kind: "research" }> & { token: string });

export type ReferenceInsertion = {
	text: string;
	references: ReferenceDraft[];
	caret: number;
};

export type ChatSendPayload = Pick<Chat.Send, "references" | "requestId" | "text" | "to">;

export type TextReplacement = {
	start: number;
	previousEnd: number;
	nextEnd: number;
};

export type ReferenceRenderModel = {
	source: string;
	references: Chat.Reference[];
};

export type ComposerDraft = {
	text: string;
	references: ReferenceDraft[];
	requestId?: string;
};

export function prepareDraftSubmission(
	draft: ComposerDraft,
	allocate: () => string = () => crypto.randomUUID(),
): ComposerDraft & { requestId: string } {
	return draft.requestId ? draft as ComposerDraft & { requestId: string } : {
		...draft,
		requestId: allocate(),
	};
}

function sameReference(left: ReferenceDraft, right: ReferenceDraft): boolean {
	return left.kind === right.kind
		&& left.start === right.start
		&& left.end === right.end
		&& left.token === right.token
		&& (left.kind === "document" && right.kind === "document"
			? left.channelId === right.channelId
			: left.kind === "research" && right.kind === "research"
			? left.workspaceId === right.workspaceId
			: false);
}

export function reviseComposerDraft(
	current: ComposerDraft,
	text: string,
	references: ReferenceDraft[],
): ComposerDraft {
	if (
		current.text === text
		&& current.references.length === references.length
		&& current.references.every((reference, index) => sameReference(reference, references[index]!))
	) return current;
	return { text, references };
}

function targetKey(value: ReferenceDraft | ReferenceTarget): string {
	return value.kind === "document"
		? `document:${value.channelId}`
		: `research:${value.workspaceId}`;
}

function validDraft(text: string, reference: ReferenceDraft): boolean {
	return Number.isSafeInteger(reference.start)
		&& Number.isSafeInteger(reference.end)
		&& reference.start >= 0
		&& reference.end > reference.start
		&& reference.end <= text.length
		&& text.slice(reference.start, reference.end) === reference.token;
}

function occurrences(text: string, token: string): number {
	let count = 0;
	let offset = 0;
	while ((offset = text.indexOf(token, offset)) >= 0) {
		count++;
		offset += token.length;
	}
	return count;
}

function moved(reference: ReferenceDraft, change: number): ReferenceDraft {
	return { ...reference, start: reference.start + change, end: reference.end + change };
}

/** Find the unfinished, whitespace-delimited reference token immediately before the caret. */
export function referenceTrigger(
	text: string,
	selectionStart: number,
	selectionEnd = selectionStart,
): ReferenceTrigger | undefined {
	if (
		!Number.isSafeInteger(selectionStart)
		|| !Number.isSafeInteger(selectionEnd)
		|| selectionStart !== selectionEnd
		|| selectionStart < 0
		|| selectionStart > text.length
	) return undefined;

	let start = selectionStart;
	while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
	let token = text.slice(start, selectionStart);
	let marker = token[0];
	if (marker !== "#" && marker !== "%") return undefined;
	let query = token.slice(1);
	if (
		query.length > MAX_REFERENCE_QUERY
		|| query.includes("#")
		|| query.includes("%")
	) return undefined;
	return {
		kind: marker === "#" ? "document" : "research",
		marker,
		query,
		start,
		end: selectionStart,
	};
}

export function referenceTriggerKey(trigger: ReferenceTrigger): string {
	return `${trigger.kind}:${trigger.start}:${trigger.end}:${trigger.query}`;
}

/** Longest common edges describe the one replacement represented by a textarea input. */
export function contiguousReplacement(previous: string, next: string): TextReplacement {
	let start = 0;
	while (start < previous.length && start < next.length && previous[start] === next[start]) start++;

	let previousEnd = previous.length;
	let nextEnd = next.length;
	while (
		previousEnd > start
		&& nextEnd > start
		&& previous[previousEnd - 1] === next[nextEnd - 1]
	) {
		previousEnd--;
		nextEnd--;
	}
	return { start, previousEnd, nextEnd };
}

/** Prefer the browser's selected replacement when it exactly explains the resulting value. */
export function selectedReplacement(
	previous: string,
	next: string,
	selection?: { start: number; end: number },
): TextReplacement {
	if (selection) {
		let inserted = next.length - previous.length + selection.end - selection.start;
		let nextEnd = selection.start + inserted;
		if (
			Number.isSafeInteger(selection.start)
			&& Number.isSafeInteger(selection.end)
			&& selection.start >= 0
			&& selection.end >= selection.start
			&& selection.end <= previous.length
			&& inserted >= 0
			&& nextEnd <= next.length
			&& previous.slice(0, selection.start) === next.slice(0, selection.start)
			&& previous.slice(selection.end) === next.slice(nextEnd)
		) {
			return { start: selection.start, previousEnd: selection.end, nextEnd };
		}
	}
	return contiguousReplacement(previous, next);
}

export function beforeInputSelection(
	start: number,
	end: number,
	inputType: string,
	length: number,
): { start: number; end: number } {
	if (start === end && inputType === "deleteContentBackward") start = Math.max(0, start - 1);
	if (start === end && inputType === "deleteContentForward") end = Math.min(length, end + 1);
	return { start, end };
}

/** Preserve only references whose exact token remained wholly outside the edited range. */
export function reconcileReferenceDrafts(
	previous: string,
	next: string,
	references: ReferenceDraft[],
	selection?: { start: number; end: number },
	allowDuplicateTokens = false,
): ReferenceDraft[] {
	let replacement = selectedReplacement(previous, next, selection);
	let change = replacement.nextEnd - replacement.previousEnd;
	let result: ReferenceDraft[] = [];

	for (let reference of references) {
		if (!validDraft(previous, reference)) continue;
		if (
			!allowDuplicateTokens
			&& occurrences(next, reference.token) > occurrences(previous, reference.token)
		) continue;
		let candidate: ReferenceDraft | undefined;
		if (reference.end <= replacement.start) candidate = reference;
		else if (reference.start >= replacement.previousEnd) candidate = moved(reference, change);
		if (candidate && validDraft(next, candidate)) result.push(candidate);
	}
	return result;
}

/** Replace the active query and bind the resulting visible token to one stable target. */
export function insertReference(
	text: string,
	references: ReferenceDraft[],
	trigger: ReferenceTrigger,
	target: ReferenceTarget,
): ReferenceInsertion {
	let expected = `${trigger.marker}${trigger.query}`;
	if (
		trigger.kind !== target.kind
		|| text.slice(trigger.start, trigger.end) !== expected
		|| !target.title
	) return { text, references, caret: trigger.end };

	let duplicate = targetKey(target);
	let deduped = references.filter(reference => targetKey(reference) !== duplicate);
	if (deduped.length >= MAX_REFERENCES) return { text, references, caret: trigger.end };

	let token = `${trigger.marker}${target.title}`;
	let next = text.slice(0, trigger.start) + token + text.slice(trigger.end);
	let shifted = reconcileReferenceDrafts(
		text,
		next,
		deduped,
		{ start: trigger.start, end: trigger.end },
		true,
	);
	let end = trigger.start + token.length;
	let reference: ReferenceDraft = target.kind === "document"
		? { kind: "document", channelId: target.channelId, start: trigger.start, end, token }
		: { kind: "research", workspaceId: target.workspaceId, start: trigger.start, end, token };
	return { text: next, references: [...shifted, reference], caret: end };
}

export function addressedOutsideReferences(
	text: string,
	references: Array<Pick<Chat.ReferenceRequest, "start" | "end">>,
): boolean {
	let masked = text.split("");
	for (let reference of references) {
		for (let index = reference.start; index < reference.end; index++) masked[index] = " ";
	}
	return addressed(masked.join(""));
}

/** Build the trimmed wire payload without allowing display text to identify a target. */
export function chatSendPayload(
	text: string,
	references: ReferenceDraft[],
	plannerEnabled: boolean,
	requestId: string,
	referencesEnabled = true,
): ChatSendPayload | undefined {
	let value = text.trim();
	if (!value) return undefined;
	let leading = text.length - text.trimStart().length;
	let trailing = text.trimEnd().length;
	let requests: Chat.ReferenceRequest[] = [];
	let targets = new Set<string>();
	let previousEnd = -1;

	for (
		let reference of [...references].sort((left, right) =>
			left.start - right.start || left.end - right.end
		)
	) {
		let key = targetKey(reference);
		if (
			!referencesEnabled
			|| requests.length >= MAX_REFERENCES
			|| targets.has(key)
			|| !validDraft(text, reference)
			|| reference.start < leading
			|| reference.end > trailing
		) continue;
		let start = reference.start - leading;
		let end = reference.end - leading;
		if (start < previousEnd || value.slice(start, end) !== reference.token) continue;
		targets.add(key);
		previousEnd = end;
		requests.push(
			reference.kind === "document"
				? { kind: "document", channelId: reference.channelId, start, end }
				: { kind: "research", workspaceId: reference.workspaceId, start, end },
		);
	}

	return {
		requestId,
		text: value,
		to: plannerEnabled && addressedOutsideReferences(value, requests) ? "planner" : "room",
		...(requests.length > 0 ? { references: requests } : {}),
	};
}

export function acknowledgeDraft(current: ComposerDraft, submitted: ComposerDraft): ComposerDraft {
	return current === submitted ? { text: "", references: [] } : current;
}

export function boundedChatError(error: unknown): string {
	let detail = error instanceof Error ? error.message.trim() : "";
	if (!detail || /^(connection lost|disposed|not connected)$/i.test(detail)) {
		return "Message not sent. Check the connection and try again.";
	}
	let maximum = 120;
	if (detail.length > maximum) detail = `${detail.slice(0, maximum - 3)}...`;
	return `Message not sent: ${detail}`;
}

function validPersistedRange(source: string, reference: Chat.Reference): boolean {
	let marker = reference.kind === "document" ? "#" : "%";
	return Number.isSafeInteger(reference.start)
		&& Number.isSafeInteger(reference.end)
		&& reference.start >= 0
		&& reference.end > reference.start
		&& reference.end <= source.length
		&& source.slice(reference.start, reference.end).startsWith(marker);
}

function acceptedPersistedReferences(
	source: string,
	references: Chat.Reference[] = [],
): Chat.Reference[] {
	if (references.length > MAX_REFERENCES) return [];
	let candidates = references
		.map((reference, order) => ({ reference, order }))
		.filter(item => validPersistedRange(source, item.reference))
		.sort((left, right) =>
			left.reference.start - right.reference.start
			|| left.reference.end - right.reference.end
			|| left.order - right.order
		);
	let accepted: typeof candidates = [];
	let group: typeof candidates = [];
	let groupEnd = -1;
	let flush = () => {
		if (group.length === 1) accepted.push(group[0]!);
		group = [];
		groupEnd = -1;
	};

	for (let candidate of candidates) {
		if (group.length === 0 || candidate.reference.start < groupEnd) {
			group.push(candidate);
			groupEnd = Math.max(groupEnd, candidate.reference.end);
		} else {
			flush();
			group.push(candidate);
			groupEnd = candidate.reference.end;
		}
	}
	flush();
	return accepted.map(item => item.reference);
}

type DisplayUnit = { value: string; source: number; protected: boolean };

function word(value: string | undefined): boolean {
	return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function protectedRange(references: Chat.Reference[], start: number, end: number): boolean {
	return references.some(reference => start < reference.end && end > reference.start);
}

function projectedDisplayUnits(source: string, references: Chat.Reference[]): DisplayUnit[] {
	let units: DisplayUnit[] = [];
	for (let offset = 0; offset < source.length; offset++) {
		let mention = source.slice(offset, offset + MENTION.length);
		if (
			mention.toLowerCase() === MENTION
			&& !protectedRange(references, offset, offset + MENTION.length)
			&& (offset === 0 || !word(source[offset - 1]) && source[offset - 1] !== "@")
			&& !word(source[offset + MENTION.length])
		) {
			offset += MENTION.length - 1;
			continue;
		}
		units.push({
			value: source[offset]!,
			source: offset,
			protected: protectedRange(references, offset, offset + 1),
		});
	}

	let collapsed: DisplayUnit[] = [];
	for (let index = 0; index < units.length;) {
		let current = units[index]!;
		if (current.protected || !/[^\S\n]/.test(current.value)) {
			collapsed.push(current);
			index++;
			continue;
		}
		let end = index + 1;
		while (
			end < units.length
			&& !units[end]!.protected
			&& /[^\S\n]/.test(units[end]!.value)
		) end++;
		collapsed.push(end - index >= 2 ? { ...current, value: " " } : current);
		index = end;
	}
	while (collapsed.length > 0 && /\s/.test(collapsed[0]!.value)) collapsed.shift();
	while (collapsed.length > 0 && /\s/.test(collapsed.at(-1)!.value)) collapsed.pop();

	let displayed: DisplayUnit[] = [];
	for (let index = 0; index < collapsed.length;) {
		let current = collapsed[index]!;
		if (
			current.value === "@"
			&& !current.protected
			&& (index === 0 || !word(collapsed[index - 1]!.value)
					&& collapsed[index - 1]!.value !== "@")
		) {
			let end = index + 1;
			if (
				end < collapsed.length && !collapsed[end]!.protected && /[A-Za-z0-9]/.test(
					collapsed[end]!.value,
				)
			) {
				end++;
				while (
					end < collapsed.length
					&& !collapsed[end]!.protected
					&& /[A-Za-z0-9-]/.test(collapsed[end]!.value)
				) end++;
				if (!word(collapsed[end]?.value)) {
					for (let handle = index + 1; handle < end; handle++) {
						displayed.push(
							handle === index + 1
								? { ...collapsed[handle]!, value: collapsed[handle]!.value.toUpperCase() }
								: collapsed[handle]!,
						);
					}
					index = end;
					continue;
				}
			}
		}
		displayed.push(current);
		index++;
	}
	return displayed;
}

/** Project display-only mentions while retaining authoritative source ranges for Markdown. */
export function referenceRenderModel(
	source: string,
	references: Chat.Reference[] = [],
): ReferenceRenderModel {
	let accepted = acceptedPersistedReferences(source, references);
	let units = projectedDisplayUnits(source, accepted);
	let displayed = units.map(unit => unit.value).join("");
	let mapped: Chat.Reference[] = [];
	for (let reference of accepted) {
		let start = units.findIndex(unit => unit.source === reference.start);
		let length = reference.end - reference.start;
		if (
			start < 0
			|| units.slice(start, start + length).some((unit, index) =>
				unit.source !== reference.start + index
			)
		) continue;
		let end = start + length;
		if (displayed.slice(start, end) !== source.slice(reference.start, reference.end)) continue;
		mapped.push({ ...reference, start, end });
	}
	return { source: displayed, references: mapped };
}
