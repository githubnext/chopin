export const STATUSES = new Set([
	"open",
	"answered",
	"reopened",
	"discarded",
	"cancelled",
	"expired",
]);
export const ORIGINS = new Set(["chat", "planner", "human"]);
export const MAX_UNIX_SECONDS = 253_402_300_799;

export type ObjectValue = { [key: string]: unknown };

export function invalid(): never {
	throw new Error("hosted channel has an invalid question record");
}

export function object(value: unknown): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as ObjectValue;
}

export function text(value: unknown, max?: number): string {
	if (typeof value !== "string" || !value.trim() || max !== undefined && value.length > max) {
		invalid();
	}
	return value as string;
}

export function unix(value: unknown): number {
	if (
		typeof value !== "number" || !Number.isSafeInteger(value)
		|| value < 0 || value > MAX_UNIX_SECONDS
	) invalid();
	return value as number;
}

export type Known = {
	questions: Map<string, { multiple: boolean; verbatim: boolean }>;
	options: Map<string, string>;
};
