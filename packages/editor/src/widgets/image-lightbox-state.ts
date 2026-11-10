/** The image a lightbox shows after a step, held between the first image and the last. */
export function stepImage(index: number, delta: number, count: number): number {
	return Math.min(Math.max(index + delta, 0), Math.max(count - 1, 0));
}

/** The arrow keys' step, or undefined for any other key. */
export function arrowStep(key: string): -1 | 1 | undefined {
	return key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : undefined;
}

/**
 * Where Tab goes from `active` among `count` controls, or undefined to let the browser move it.
 * Focus wraps at both ends so a reader never reaches the page behind the lightbox.
 */
export function wrapTab(active: number, count: number, backwards: boolean): number | undefined {
	if (count === 0) return undefined;
	if (active < 0) return backwards ? count - 1 : 0;
	if (backwards && active === 0) return count - 1;
	if (!backwards && active === count - 1) return 0;
	return undefined;
}
