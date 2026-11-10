import type { Chat } from "@chopin/protocol";

export type Intent = { id: string; emoji: string; on: boolean; sent?: true };

export type IntentAction =
	| { kind: "ask"; id: string; emoji: string; on: boolean }
	| { kind: "sent"; id: string; emoji: string; on: boolean }
	| { kind: "unsent"; id: string; emoji: string; on: boolean }
	| { kind: "drop"; id: string; emoji: string; on: boolean }
	| { kind: "settle"; id: string; reactions: readonly Chat.Reaction[] | undefined; handle: string }
	| { kind: "history"; entries: readonly Chat.Entry[]; handle: string }
	| { kind: "prune"; present: ReadonlySet<string> };

function kept(before: readonly Intent[], after: Intent[]): readonly Intent[] {
	return after.length === before.length ? before : after;
}

function same(intent: Intent, id: string, emoji: string): boolean {
	return intent.id === id && intent.emoji === emoji;
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
				{ id: action.id, emoji: action.emoji, on: action.on },
			];
		case "sent":
			return intents.map(intent =>
				same(intent, action.id, action.emoji) && intent.on === action.on
					? { ...intent, sent: true }
					: intent
			);
		case "unsent":
			return intents.map(intent =>
				same(intent, action.id, action.emoji) && intent.on === action.on
					? { id: intent.id, emoji: intent.emoji, on: intent.on }
					: intent
			);
		case "drop":
			return intents.filter(intent =>
				!(same(intent, action.id, action.emoji) && intent.on === action.on)
			);
		case "settle":
			return kept(
				intents,
				intents.filter(intent =>
					intent.id !== action.id || !satisfied(intent, action.reactions, action.handle)
				),
			);
		case "history": {
			let reactions = new Map(action.entries.map(entry => [entry.id, entry.reactions]));
			return intents
				.map(intent => ({ id: intent.id, emoji: intent.emoji, on: intent.on }))
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
