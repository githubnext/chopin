export const MAX_QUOTE_CANDIDATES = 4;

export function assertQuoteBudget(candidates: readonly unknown[]): void {
	if (candidates.length > MAX_QUOTE_CANDIDATES) {
		throw new Error(`source quote count exceeds ${MAX_QUOTE_CANDIDATES}`);
	}
}
