/**
 * Measuring a state that eases: where something was on every animation frame while a change ran
 * and the page settled. An element that eases open or shut passes through values between where it
 * began and ended; one that jumps, or that reduced motion settles at once, moves in a single step.
 */
import type { Locator } from "@playwright/test";

export const top = (element: Element) => element.getBoundingClientRect().top;
export const height = (element: Element) => element.getBoundingClientRect().height;

export async function trace(
	target: Locator,
	measure: (element: Element) => number,
	act: () => Promise<void>,
): Promise<number[]> {
	let recorder = await target.evaluateHandle((element, source) => {
		let measuring = new Function(`return (${source})`)() as (element: Element) => number;
		let seen: number[] = [];
		let running = true;
		let tick = () => {
			seen.push(Math.round(measuring(element) * 10) / 10);
			if (running) requestAnimationFrame(tick);
		};
		tick();
		return {
			stop() {
				running = false;
				return seen;
			},
		};
	}, measure.toString());
	await act();
	await target.page().waitForTimeout(600);
	return await recorder.evaluate(handle => handle.stop());
}

/** The values a measure passed through strictly between where it began and where it ended. */
export function inBetween(seen: number[]): number[] {
	let from = seen[0]!;
	let to = seen.at(-1)!;
	let low = Math.min(from, to);
	let high = Math.max(from, to);
	return [...new Set(seen)].filter(value => value > low && value < high);
}
