/**
 * The one banner of the page, read from the browser: the connection banner (the room's socket, the
 * document catching up, the Planner's own connection) and the failure banner of a Planner turn are
 * one family and show one at a time, so a cause is told by one of them. A screen reader hears the
 * connection banner's phases from one polite live region, never from the banner itself.
 */
import type { Locator, Page } from "@playwright/test";

/** The connection banner, wherever the page draws it: by the Chat composer or at the document. */
export function connectionBanner(page: Page): Locator {
	return page.locator("[data-connection-banner]");
}

/** Every banner of the page, connection or failure. */
export function allBanners(page: Page): Locator {
	return page.locator("[data-banner]");
}

/** The failure banner of a Planner turn or of a refused send. */
export function failureBanner(page: Page): Locator {
	return page.locator("[data-error-banner]");
}

/** The page's one polite live region, which speaks each phase once. */
export function phaseVoice(page: Page): Locator {
	return page.locator("[data-connection-status]");
}

/** How long the banner says it is back before it goes, and a little over. */
export const RESUMED_WAIT = { timeout: 8_000 };

/**
 * Every word the live region is given from now on, in order, and every banner that is added to
 * the page with what its entrance did: its animation and its opacity on each frame after it was
 * added. Install before the page opens; it survives reloads.
 */
export async function watchBanners(page: Page): Promise<void> {
	await page.addInitScript(() => {
		let heard: string[] = [];
		let entrances: Array<{ animation: string; opacity: number[] }> = [];
		let target = window as unknown as {
			heardWords: string[];
			bannerEntrances: typeof entrances;
		};
		target.heardWords = heard;
		target.bannerEntrances = entrances;
		let last = "";
		let read = () => {
			let text = document.querySelector("[data-connection-status]")?.textContent ?? "";
			if (text === last) return;
			last = text;
			if (text) heard.push(text);
		};
		let enter = (element: Element) => {
			let entrance = {
				animation: getComputedStyle(element).animationName,
				opacity: [] as number[],
			};
			entrances.push(entrance);
			let until = performance.now() + 800;
			let tick = () => {
				entrance.opacity.push(Number(getComputedStyle(element).opacity));
				if (performance.now() < until) requestAnimationFrame(tick);
			};
			tick();
		};
		addEventListener("DOMContentLoaded", () => {
			new MutationObserver(records => {
				read();
				for (let record of records) {
					for (let node of record.addedNodes) {
						if (!(node instanceof Element)) continue;
						if (node.matches("[data-banner]")) enter(node);
						node.querySelectorAll("[data-banner]").forEach(enter);
					}
				}
			}).observe(document.body, { characterData: true, childList: true, subtree: true });
			read();
		});
	});
}

/** What the live region said, in order, since `watchBanners`. */
export function heardWords(page: Page): Promise<string[]> {
	return page.evaluate(
		() => [...(window as unknown as { heardWords: string[] }).heardWords],
	);
}

/** Each banner added since `watchBanners`, with its animation and its opacity on each frame. */
export function bannerEntrances(page: Page) {
	return page.evaluate(
		() =>
			(window as unknown as { bannerEntrances: Array<{ animation: string; opacity: number[] }> })
				.bannerEntrances,
	);
}

/**
 * What `root` says, matching `words`, anywhere but in the connection banner: a banner is the one
 * place the connection is told.
 */
export function wordsOutsideBanner(root: Locator, words: RegExp): Promise<string[]> {
	return root.evaluate((element, { source, flags }) => {
		let pattern = new RegExp(source, flags);
		return [...element.querySelectorAll("*")]
			.filter(node =>
				node.children.length === 0 && pattern.test(node.textContent ?? "")
				&& !node.closest("[data-connection-banner]")
			)
			.map(node => node.textContent ?? "");
	}, { source: words.source, flags: words.flags });
}
