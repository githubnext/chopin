import type { Chat } from "@chopin/protocol";

export type Intent = { id: string; emoji: string; on: boolean; seq?: number; sent?: true };

export type IntentAction =
	| { kind: "ask"; id: string; emoji: string; on: boolean; seq?: number }
	| { kind: "sent"; id: string; emoji: string; on: boolean; seq?: number }
	| { kind: "unsent"; id: string; emoji: string; on: boolean; seq?: number }
	| { kind: "drop"; id: string; emoji: string; on: boolean; seq?: number }
	| {
		kind: "settle";
		id: string;
		reactions: readonly Chat.Reaction[] | undefined;
		handle: string;
		answers?: { emoji: string; on: boolean; seq?: number };
		applied?: { by: string; emoji: string; seq?: number };
	}
	| { kind: "history"; entries: readonly Chat.Entry[]; handle: string }
	| { kind: "prune"; present: ReadonlySet<string> };

function unsent(intent: Intent): Intent {
	return {
		id: intent.id,
		emoji: intent.emoji,
		on: intent.on,
		...(intent.seq === undefined ? {} : { seq: intent.seq }),
	};
}

function kept(before: readonly Intent[], after: Intent[]): readonly Intent[] {
	return after.length === before.length ? before : after;
}

function same(intent: Intent, id: string, emoji: string): boolean {
	return intent.id === id && intent.emoji === emoji;
}

function request(intent: Intent, action: { on: boolean; seq?: number }): boolean {
	return intent.on === action.on && (action.seq === undefined || intent.seq === action.seq);
}

function current(intent: Intent, seq: number | undefined): boolean {
	return seq === undefined || intent.seq === undefined || intent.seq <= seq;
}

function settles(intent: Intent, action: Extract<IntentAction, { kind: "settle" }>): boolean {
	if (intent.id !== action.id) return false;
	let { answers, applied } = action;
	if (applied && (applied.by !== action.handle || applied.emoji !== intent.emoji)) return false;
	if (answers && (answers.emoji !== intent.emoji || answers.on !== intent.on)) return false;
	return current(intent, (answers ?? applied)?.seq)
		&& satisfied(intent, action.reactions, action.handle);
}

function satisfied(
	intent: Intent,
	reactions: readonly Chat.Reaction[] | undefined,
	handle: string,
): boolean {
	let held = reactions?.some(item => item.emoji === intent.emoji && item.handles.includes(handle));
	return !!held === intent.on;
}

export function intentsReducer(
	intents: readonly Intent[],
	action: IntentAction,
): readonly Intent[] {
	switch (action.kind) {
		case "ask":
			return [
				...intents.filter(intent => !same(intent, action.id, action.emoji)),
				{
					id: action.id,
					emoji: action.emoji,
					on: action.on,
					...(action.seq === undefined ? {} : { seq: action.seq }),
				},
			];
		case "sent":
			return intents.map(intent =>
				same(intent, action.id, action.emoji) && request(intent, action)
					? { ...intent, sent: true }
					: intent
			);
		case "unsent":
			return intents.map(intent =>
				same(intent, action.id, action.emoji) && request(intent, action) ? unsent(intent) : intent
			);
		case "drop":
			return intents.filter(intent =>
				!(same(intent, action.id, action.emoji) && request(intent, action))
			);
		case "settle":
			return kept(intents, intents.filter(intent => !settles(intent, action)));
		case "history": {
			let reactions = new Map(action.entries.map(entry => [entry.id, entry.reactions]));
			return intents
				.map(unsent)
				.filter(intent =>
					!reactions.has(intent.id) || !satisfied(intent, reactions.get(intent.id), action.handle)
				);
		}
		case "prune":
			return kept(intents, intents.filter(intent => action.present.has(intent.id)));
	}
}

export function dueNow(intents: readonly Intent[], saved: ReadonlySet<string>): Intent[] {
	return intents.filter(intent => !intent.sent && saved.has(intent.id));
}

export function withIntents(
	reactions: readonly Chat.Reaction[] | undefined,
	intents: readonly Intent[],
	id: string,
	handle: string,
): { reactions: Chat.Reaction[]; pending: Set<string> } {
	let result = (reactions ?? []).map(item => ({ emoji: item.emoji, handles: [...item.handles] }));
	let pending = new Set<string>();
	for (let intent of intents) {
		if (intent.id !== id) continue;
		let held = result.find(item => item.emoji === intent.emoji);
		let has = !!held?.handles.includes(handle);
		if (has === intent.on) continue;
		pending.add(intent.emoji);
		if (intent.on && held) held.handles.push(handle);
		else if (intent.on) result.push({ emoji: intent.emoji, handles: [handle] });
		else if (held) held.handles = held.handles.filter(item => item !== handle);
	}
	return { reactions: result.filter(item => item.handles.length > 0), pending };
}
