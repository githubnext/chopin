import type { BrowserContext, Page } from "@playwright/test";

export type VisualViewportState = {
	height: number;
	offsetLeft: number;
	offsetTop: number;
	pageLeft: number;
	pageTop: number;
	scale: number;
	width: number;
};

export type VisualViewportChange = Partial<VisualViewportState> & {
	event: "resize" | "scroll";
};

/** Install before navigation so listeners see the same mutable viewport from boot. */
export async function installVisualViewport(
	target: BrowserContext | Page,
	initial: VisualViewportState,
): Promise<void> {
	await target.addInitScript(value => {
		let state = { ...value };
		let viewport = new EventTarget();
		for (let key of Object.keys(state) as (keyof typeof state)[]) {
			Object.defineProperty(viewport, key, {
				get() {
					return state[key];
				},
			});
		}
		Object.defineProperty(window, "visualViewport", {
			configurable: true,
			value: viewport,
		});
		Object.defineProperty(window, "__setVisualViewport", {
			configurable: true,
			value(change: VisualViewportChange) {
				let { event, ...next } = change;
				Object.assign(state, next);
				viewport.dispatchEvent(new Event(event));
			},
		});
	}, initial);
}

/** Mutate the emulated browser API, then notify its actual EventTarget. */
export async function setVisualViewport(
	page: Page,
	change: VisualViewportChange,
): Promise<void> {
	await page.evaluate(value => {
		(window as typeof window & {
			__setVisualViewport(next: VisualViewportChange): void;
		}).__setVisualViewport(value);
	}, change);
}
