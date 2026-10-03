export const MAX_CONTRIBUTIONS = 64;
export const MAX_THREADS = 20;
export const MAX_EVENTS = 4096;
export const MAX_ANALYSIS = 64;
export const MAX_QUEUE = 128;
export const MAX_RESEARCH_OFFERS = 64;

export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("invalid conversation plan record");
	}
	return value as Record<string, unknown>;
}

export function knownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some((key) => !allowed.includes(key))) {
		throw new Error("unknown conversation plan field");
	}
}

export function id(value: unknown): void {
	if (typeof value !== "string" || !value || value.length > 200) {
		throw new Error("invalid conversation plan ID");
	}
}

export function text(value: unknown, max = 500): void {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new Error("invalid conversation plan text");
	}
}

/** Only an owned, direct preference with explicit provisional scope can propose a spike choice. */
export function spikePreferenceLabel(quote: string): string | undefined {
	return /^I(?:['’]d| would) pick (.+?) for (?:the|a) spike[;.!]?$/iu.exec(quote.trim())?.[1];
}

export function spikeAgreementLabel(quote: string): string | undefined {
	return /^yep,\s+(.+?) for (?:the|a) spike[.!]$/iu.exec(quote.trim())?.[1];
}

export function version(value: unknown): void {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new Error("invalid conversation plan version");
	}
}

export function actor(value: unknown): void {
	let a = record(value);
	knownKeys(a, a.kind === "member" ? ["kind", "handle"] : ["kind"]);
	if (a.kind === "classifier" || a.kind === "agent") return;
	if (a.kind === "member") return id(a.handle);
	throw new Error("invalid conversation plan actor");
}
