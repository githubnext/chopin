import { createHash } from "node:crypto";
// Extracted from archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2, effects.ts.

export const MAX_EFFECTS = 1024;

export function invalid(): never {
	throw new Error("hosted channel has invalid conversation effects");
}

export function object(
	value: unknown,
	keys: string[],
	optional: string[] = [],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	let record = value as Record<string, unknown>;
	if (
		Object.keys(record).some(key => !keys.includes(key) && !optional.includes(key))
		|| keys.some(key => !Object.hasOwn(record, key))
	) return invalid();
	return record;
}

export function bounded(value: unknown, max: number): value is string {
	return typeof value === "string" && !!value.trim() && value.length <= max;
}

export function scopedKey(proposalId: string, triggerEventId: string): string {
	let raw = triggerEventId === proposalId
		? `scoped-choice:${proposalId}:proposal`
		: `scoped-choice:${proposalId}:agreement:${triggerEventId}`;
	return raw.length <= 300
		? raw
		: `scoped-choice:${createHash("sha256").update(raw).digest("hex")}`;
}
