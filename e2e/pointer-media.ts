import type { BrowserContext, Page } from "@playwright/test";

export type PointerMedia = { coarse: boolean; primaryCoarse: boolean };

/** Model a browser with both touch input and a separate primary pointer. */
export async function installPointerMedia(
	target: BrowserContext | Page,
	state: PointerMedia,
): Promise<void> {
	await target.addInitScript(value => {
		let native = window.matchMedia.bind(window);
		Object.defineProperty(window, "matchMedia", {
			configurable: true,
			value: (query: string) => {
				let matches = query === "(any-pointer: coarse)"
					? value.coarse
					: query === "(pointer: coarse)"
					? value.primaryCoarse
					: query === "(pointer: fine)"
					? !value.primaryCoarse
					: undefined;
				if (matches === undefined) return native(query);
				let list = new EventTarget() as MediaQueryList;
				Object.defineProperty(list, "matches", { get: () => matches });
				Object.defineProperty(list, "media", { value: query });
				return list;
			},
		});
	}, state);
}
