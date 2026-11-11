import { addressed, MENTION } from "@chopin/protocol/address";

import type { Chat } from "@chopin/protocol";

export const MAX_REFERENCES = 10;
export const MAX_REFERENCE_QUERY = 64;

export type ReferenceTrigger = {
	kind: "document";
	marker: "#";
	query: string;
	start: number;
	end: number;
};

export type ReferenceTarget = {
	kind: "document";
	channelId: string;
	title: string;
	slug?: string;
	child?: boolean;
	parentTitle?: string;
	description?: string;
};

/**
 * A reference in the draft: what the server is asked for, over the range of the token the person
 * sees. A document is a `#` token, a research card a `%` token, a heading, a Decision or a file an
 * `@` token and a command a `/` token.
 */
export type ReferenceDraft = Chat.ReferenceRequest & { token: string };

export type ReferenceInsertion = {
	text: string;
	references: ReferenceDraft[];
	caret: number;
};

export type ChatSendPayload = Pick<
	Chat.Send,
	"attachments" | "focus" | "references" | "requestId" | "text" | "to"
>;

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
	/** One request identity owns its complete prepared wire payload, including absent focus. */
	submission?: ChatSendPayload;
};

export function prepareDraftSubmission(
	draft: ComposerDraft,
	allocate: () => string = () => crypto.randomUUID(),
	context: {
		planner?: boolean;
		asking?: boolean;
		referencesEnabled?: boolean;
		focus?: string;
		/** The message carries files, so it may have no text. */
		files?: boolean;
	} = {},
): (ComposerDraft & { submission: ChatSendPayload }) | undefined {
	if (draft.submission) return draft as ComposerDraft & { submission: ChatSendPayload };
	let prefix = context.planner !== false && context.asking
			&& !addressedOutsideReferences(draft.text, draft.references)
		? `${MENTION} `
		: "";
	let submission = chatSendPayload(
		prefix + draft.text,
		draft.references.map(reference => ({
			...reference,
			start: reference.start + prefix.length,
			end: reference.end + prefix.length,
		})),
		context.planner !== false,
		allocate(),
		context.referencesEnabled !== false,
		context.focus,
		context.files === true,
	);
	return submission ? { ...draft, submission } : undefined;
}

/** Rebuild a stored payload from its visible draft, accepting only an identical projection. */
export function restoreDraftSubmission(
	draft: ComposerDraft,
	value: unknown,
): ChatSendPayload | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	let saved = value as Partial<ChatSendPayload>;
	let uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	if (
		typeof saved.requestId !== "string" || !uuid.test(saved.requestId)
		|| typeof saved.text !== "string" || !["room", "planner"].includes(saved.to ?? "")
		|| (saved.focus !== undefined && (typeof saved.focus !== "string" || !uuid.test(saved.focus)))
	) return;
	let prepared = prepareDraftSubmission(
		{ text: draft.text, references: draft.references },
		() => saved.requestId!,
		{
			planner: saved.to === "planner" || saved.focus !== undefined,
			asking: saved.text !== draft.text.trim(),
			referencesEnabled: saved.references !== undefined,
			focus: saved.focus,
		},
	)?.submission;
	return prepared?.text === saved.text && prepared.to === saved.to && prepared.focus === saved.focus
			&& JSON.stringify(prepared.references) === JSON.stringify(saved.references)
		? prepared
		: undefined;
}

function sameReference(left: ReferenceDraft, right: ReferenceDraft): boolean {
	return left.start === right.start
		&& left.end === right.end
		&& left.token === right.token
		&& targetKey(left) === targetKey(right);
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

/** What a draft reference points at, so one target is never in a draft twice. */
export function referenceTargetKey(value: ReferenceDraft | ReferenceTarget): string {
	switch (value.kind) {
		case "document":
			return `document:${value.channelId}`;
		case "research":
			return `research:${value.workspaceId}`;
		case "command":
			return `command:${value.commandKind}:${value.name}`;
		case "heading":
			return `heading:${value.anchor}`;
		case "decision":
			return `decision:${value.decisionId}`;
		case "file":
			return `file:${value.path}`;
	}
}

function targetKey(value: ReferenceDraft | ReferenceTarget): string {
	return referenceTargetKey(value);
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
	if (marker !== "#") return undefined;
	let query = token.slice(1);
	if (
		query.length > MAX_REFERENCE_QUERY
		|| query.includes("#")
		|| query.includes("%")
	) return undefined;
	return {
		kind: "document",
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
	let reference: ReferenceDraft = {
		kind: "document",
		channelId: target.channelId,
		start: trigger.start,
		end,
		token,
	};
	return { text: next, references: [...shifted, reference], caret: end };
}

/** A part of the document, or a file, `@` can point at, with the words the token shows. */
export type PointerTarget =
	| { kind: "heading"; anchor: string; label: string }
	| { kind: "decision"; decisionId: string; label: string }
	| { kind: "research"; workspaceId: string; label: string }
	| { kind: "file"; path: string; label: string };

function pointerRequest(
	target: PointerTarget,
): Chat.ReferenceRequest extends infer R
	? R extends { start: number; end: number } ? Omit<R, "start" | "end"> : never
	: never
{
	switch (target.kind) {
		case "heading":
			return { kind: "heading", anchor: target.anchor };
		case "decision":
			return { kind: "decision", decisionId: target.decisionId };
		case "research":
			return { kind: "research", workspaceId: target.workspaceId };
		case "file":
			return { kind: "file", path: target.path };
	}
}

/**
 * Replace the typed `@query` with the part's own words as one chip (`%` for a research card), a
 * space after it, and the caret after that. A part already in the draft moves to its new place
 * rather than appearing twice, and a draft that holds the most references is left as it was.
 */
export function insertPointer(
	text: string,
	references: ReferenceDraft[],
	trigger: { query: string; start: number; end: number },
	target: PointerTarget,
): ReferenceInsertion {
	if (text.slice(trigger.start, trigger.end) !== `@${trigger.query}` || !target.label) {
		return { text, references, caret: trigger.end };
	}
	let request = pointerRequest(target);
	let key = referenceTargetKey({ ...request, start: 0, end: 0, token: "" } as ReferenceDraft);
	let deduped = references.filter(reference => referenceTargetKey(reference) !== key);
	if (deduped.length >= MAX_REFERENCES) return { text, references, caret: trigger.end };
	let token = `${target.kind === "research" ? "%" : "@"}${target.label}`;
	let spaced = text[trigger.end] === " ";
	let next = text.slice(0, trigger.start) + token + (spaced ? "" : " ") + text.slice(trigger.end);
	let shifted = reconcileReferenceDrafts(
		text,
		next,
		deduped,
		{ start: trigger.start, end: trigger.end },
		true,
	);
	let end = trigger.start + token.length;
	return {
		text: next,
		references: [...shifted, { ...request, start: trigger.start, end, token } as ReferenceDraft],
		caret: end + 1,
	};
}

/**
 * Replace the typed `/query`, which is the whole draft so far, with the command as a chip that
 * opens the draft, and a space after it for the words it is run with.
 */
export function insertCommand(
	text: string,
	references: ReferenceDraft[],
	trigger: { end: number },
	command: { name: string; commandKind: string },
): ReferenceInsertion {
	let token = `/${command.name}`;
	let next = `${token} ${text.slice(trigger.end).replace(/^ /, "")}`;
	let kept = references.filter(reference =>
		reference.kind !== "command" && reference.start >= trigger.end
	)
		.map(reference => ({
			...reference,
			start: reference.start + next.length - text.length,
			end: reference.end + next.length - text.length,
		}));
	return {
		text: next,
		references: [{
			kind: "command",
			name: command.name,
			commandKind: command.commandKind,
			start: 0,
			end: token.length,
			token,
		}, ...kept],
		caret: token.length + 1,
	};
}

/**
 * What an edit touches once a chip is whole: a chip is one thing, so deleting at its edge, or any
 * of it, takes all of it, a selection that reaches into one takes the rest, and a caret inside
 * one (it can be put there with the mouse) goes to its end before anything is typed.
 */
export function expandToChips(
	references: ReadonlyArray<Pick<ReferenceDraft, "start" | "end">>,
	start: number,
	end: number,
	inputType: string,
): { start: number; end: number } {
	let chips = [...references].sort((left, right) => left.start - right.start);
	if (start === end) {
		let deleting = inputType.startsWith("delete");
		let backward = inputType.includes("Backward");
		for (let chip of chips) {
			if (deleting) {
				if (
					backward
						? chip.start < start && start <= chip.end
						: chip.start <= start && start < chip.end
				) {
					return { start: chip.start, end: chip.end };
				}
			} else if (chip.start < start && start < chip.end) {
				return { start: chip.end, end: chip.end };
			}
		}
		return { start, end };
	}
	for (let pass = 0; pass < 2; pass++) {
		for (let chip of chips) {
			if (chip.start < end && chip.end > start) {
				start = Math.min(start, chip.start);
				end = Math.max(end, chip.end);
			}
		}
	}
	return { start, end };
}

/** Whether the draft runs a command, which is only ever for the Planner. */
export function runsCommand(references: ReadonlyArray<Pick<ReferenceDraft, "kind">>): boolean {
	return references.some(reference => reference.kind === "command");
}

/**
 * Whether the text outside its references addresses the Planner. A command is an address of its
 * own: it runs in the Planner's turn, so a draft that holds one needs no `@chopin`.
 */
export function addressedOutsideReferences(
	text: string,
	references: Array<Pick<Chat.ReferenceRequest, "start" | "end"> & { kind?: string }>,
): boolean {
	if (references.some(reference => reference.kind === "command")) return true;
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
	focus?: string,
	files = false,
): ChatSendPayload | undefined {
	let value = text.trim();
	if (!value && !files) return undefined;
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
		let { token: _token, ...request } = reference;
		requests.push({ ...request, start, end });
	}

	let to: Chat.Destination = plannerEnabled && addressedOutsideReferences(value, requests)
		? "planner"
		: "room";
	return {
		requestId,
		text: value,
		to,
		...(requests.length > 0 ? { references: requests } : {}),
		...(plannerEnabled && focus ? { focus } : {}),
	};
}

/** What a server whose agent is off says to a person, in the composer's strip and after a send. */
export const REPLIES_OFF = "Replies are off on this server.";

export const PLANNER_UNAVAILABLE_NOTICE =
	`${REPLIES_OFF} Your message went to the people here only.`;

/**
 * The composer's strip for a server whose agent is off. A lost connection is the page's one
 * notice, so while that shows the composer says nothing of availability, and the strip returns by
 * itself with the connection.
 */
export function repliesOffNotice(offline: boolean): { tone: "info"; text: string } | undefined {
	return offline ? undefined : { tone: "info", text: REPLIES_OFF };
}

/** Whether a payload names the Planner, even though it was routed to the room. */
export function addressesPlanner(payload: ChatSendPayload): boolean {
	return addressedOutsideReferences(payload.text, payload.references ?? []);
}

/** Put each local notice directly under the message it answers; unknown messages are skipped. */
export function withNoticesAfter(
	entries: Chat.Entry[],
	notices: Readonly<Record<string, Chat.Entry>>,
): Chat.Entry[] {
	if (Object.keys(notices).length === 0) return entries;
	return entries.flatMap(entry => notices[entry.id] ? [entry, notices[entry.id]!] : [entry]);
}

/**
 * Where the composer will send a draft, as the wire will see it, and how to say so
 * before it is sent. Nothing is said for an empty draft or when the Planner is off.
 */
export function destinationCue(
	text: string,
	references: ReferenceDraft[],
	plannerEnabled: boolean,
	referencesEnabled = true,
): { to: "planner" | "room"; text: string } | undefined {
	if (!plannerEnabled) return undefined;
	let to = chatSendPayload(text, references, plannerEnabled, "", referencesEnabled)?.to;
	if (!to) return undefined;
	return to === "planner"
		? { to, text: "Sends to Chopin, which will reply" }
		: { to, text: "Sent to people here. Type @ to ask Chopin" };
}

export function acknowledgeDraft(current: ComposerDraft, submitted: ComposerDraft): ComposerDraft {
	return current === submitted ? { text: "", references: [] } : current;
}

/** A send that failed as the composer tells it, and whether the connection is what failed it. */
export type SendFailure = { text: string; lost: boolean };

export function sendFailure(error: unknown): SendFailure {
	let detail = error instanceof Error ? error.message.trim() : "";
	if (detail && (error as { code?: unknown }).code === "planner-not-attached") {
		return { text: detail, lost: false };
	}
	if (!detail || /^(connection lost|disposed|not connected)$/i.test(detail)) {
		return { text: "Message not sent. Check the connection and try again.", lost: true };
	}
	let maximum = 120;
	if (detail.length > maximum) detail = `${detail.slice(0, maximum - 3)}...`;
	return { text: `Message not sent: ${detail}`, lost: false };
}

export function boundedChatError(error: unknown): string {
	return sendFailure(error).text;
}

/**
 * What the composer tells of a failed send. While the page's connection banner shows it tells none: a
 * lost connection is that notice's to tell, and a strip beside it would be a second alert for a
 * problem the person cannot act on. A failure the server refused is kept meanwhile, and told as it
 * was once the connection is back. A send the connection cut off has no strip of its own while the
 * connection is down, so a blip, which shows no notice, says nothing either.
 */
export function shownSendFailure<T extends SendFailure>(
	failure: T | undefined,
	connected: boolean,
	offline: boolean,
): T | undefined {
	return offline || (failure?.lost && !connected) ? undefined : failure;
}

/** The character a sent reference's token opens with. */
export function referenceMarker(kind: Chat.Reference["kind"]): "#" | "%" | "/" | "@" {
	return kind === "document"
		? "#"
		: kind === "research"
		? "%"
		: kind === "command"
		? "/"
		: "@";
}

/** What a sent reference asks the server for, so the same message can be sent again as it was. */
export function referenceRequest(reference: Chat.Reference): Chat.ReferenceRequest {
	let { start, end } = reference;
	switch (reference.kind) {
		case "document":
			return { kind: "document", channelId: reference.channelId, start, end };
		case "research":
			return { kind: "research", workspaceId: reference.workspaceId, start, end };
		case "command":
			return {
				kind: "command",
				name: reference.name,
				commandKind: reference.commandKind,
				start,
				end,
			};
		case "heading":
			return { kind: "heading", anchor: reference.anchor, start, end };
		case "decision":
			return { kind: "decision", decisionId: reference.decisionId, start, end };
		case "file":
			return { kind: "file", path: reference.path, start, end };
	}
}

function validPersistedRange(source: string, reference: Chat.Reference): boolean {
	let marker = referenceMarker(reference.kind);
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
			// Whitespace is Markdown structure (indentation, code, hard breaks), so
			// only the space left doubled by the removed mention is dropped.
			let previous = units.at(-1);
			if (previous && !previous.protected && /[^\S\n]/.test(previous.value)) {
				while (
					/[^\S\n]/.test(source[offset + 1] ?? "")
					&& !protectedRange(references, offset + 1, offset + 2)
				) offset++;
			}
			continue;
		}
		units.push({
			value: source[offset]!,
			source: offset,
			protected: protectedRange(references, offset, offset + 1),
		});
	}

	let collapsed = units;
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
