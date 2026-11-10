export function stepImage(index: number, delta: number, count: number): number {
	return Math.min(Math.max(index + delta, 0), Math.max(count - 1, 0));
}

export function arrowStep(key: string): -1 | 1 | undefined {
	return key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : undefined;
}

export function wrapTab(active: number, count: number, backwards: boolean): number | undefined {
	if (count === 0) return undefined;
	if (active < 0) return backwards ? count - 1 : 0;
	if (backwards && active === 0) return count - 1;
	if (!backwards && active === count - 1) return 0;
	return undefined;
}
