import { failedBuild } from "./build-seed";
import type { Graph } from "../apps/server/src/tasks/graphs";
import { expect, test } from "./room";
import { RESPONSIVE_SOURCE } from "./responsive";

import type { Chat } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

const PHONES = [
	{ name: "iPhone 15 Pro", width: 393, height: 659 },
	{ name: "iPhone SE", width: 375, height: 667 },
] as const;

function transcript(): Chat.Entry[] {
	return Array.from({ length: 24 }, (_, index) => ({
		id: `message-${index}`,
		author: { kind: "member" as const, handle: index % 2 ? "ana" : "ben" },
		text: `Message ${index} about the rollout plan and what it still needs.`,
		ts: 1_700_000_000 + index,
	}));
}

type Edges = { chromeTop: number; first: number; chromeBottom: number; last: number };

/**
 * Scroll the visible pane scroller to one end, then compare its first or last line of content
 * with the bars that float over it: the top bar (and a child's stack bar) above, and the tab
 * bar, save bar or composer below.
 */
async function edges(page: Page, scroller: string, end: "top" | "bottom"): Promise<Edges> {
	return page.evaluate(async ({ scroller, end }) => {
		let shown = (element: Element) => {
			let box = element.getBoundingClientRect();
			let style = getComputedStyle(element);
			return box.width > 0 && box.height > 0 && style.visibility !== "hidden"
				&& Number(style.opacity) > 0;
		};
		// A tab change slides the pane in; wait until it has settled on screen.
		let pane: HTMLElement | undefined;
		for (let attempt = 0; !pane && attempt < 40; attempt++) {
			pane = [...document.querySelectorAll<HTMLElement>(scroller)].find(element => {
				let box = element.getBoundingClientRect();
				return shown(element) && box.left >= -1 && box.right <= innerWidth + 1;
			});
			if (!pane) await new Promise(resolve => setTimeout(resolve, 50));
		}
		if (!pane) throw new Error(`no settled ${scroller}`);
		pane.scrollTo({ top: end === "top" ? 0 : pane.scrollHeight });
		await new Promise(resolve => setTimeout(resolve, 400));

		let chromeTop = 0;
		for (let bar of document.querySelectorAll(".phone-top-bar, .workspace-stack-bar")) {
			if (shown(bar)) chromeTop = Math.max(chromeTop, bar.getBoundingClientRect().bottom);
		}
		let chromeBottom = innerHeight;
		for (
			let bar of document.querySelectorAll(
				".phone-tab-row, .decision-save-bar[data-open], .chat-composer",
			)
		) {
			if (shown(bar)) chromeBottom = Math.min(chromeBottom, bar.getBoundingClientRect().top);
		}

		let first = Infinity;
		let last = -Infinity;
		let walker = document.createTreeWalker(pane, NodeFilter.SHOW_TEXT);
		let range = document.createRange();
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			let parent = node.parentElement!;
			if (!node.textContent!.trim() || parent.closest(".sr-only, [aria-hidden='true']")) continue;
			if (!shown(parent)) continue;
			range.selectNodeContents(node);
			let box = range.getBoundingClientRect();
			if (!box.height) continue;
			first = Math.min(first, box.top);
			last = Math.max(last, box.bottom);
		}
		return { chromeTop, first, chromeBottom, last };
	}, { scroller, end });
}

async function expectClear(page: Page, scroller: string): Promise<void> {
	let top = await edges(page, scroller, "top");
	expect(top.first, "first line below the top chrome").toBeGreaterThanOrEqual(top.chromeTop);
	let bottom = await edges(page, scroller, "bottom");
	expect(bottom.last, "last line above the bottom chrome").toBeLessThanOrEqual(bottom.chromeBottom);
}

async function show(page: Page, name: RegExp | string): Promise<void> {
	let tab = page.getByRole("navigation", { name: "Workspace view" }).getByRole("button", { name });
	await tab.click();
	await expect(tab).toHaveAttribute("aria-current", "page");
}

for (let phone of PHONES) {
	test.describe(`${phone.name}: pane content clears the phone bars`, () => {
		let options = {
			hasTouch: true,
			isMobile: true,
			viewport: { width: phone.width, height: phone.height },
		};

		test("Document", async ({ join, seed }) => {
			await seed(RESPONSIVE_SOURCE);
			let page = await join("ana", options);
			await expect(page.locator(".plan-content")).toContainText("Responsive architecture");
			await expectClear(page, "[data-plan-scroll]");
		});

		test("Chat", async ({ join, seed }) => {
			await seed("# Chat clearance\n", { transcript: transcript() });
			let page = await join("ana", options);
			await show(page, /^Chat/);
			await expect(page.getByText("Message 23 about the rollout plan")).toBeVisible();
			await expectClear(page, "[data-chat-scroll]");
		});

		test("Decisions, with and without the save bar", async ({ join, seed }) => {
			await seed("Decisions on a phone.\n");
			let page = await join("ana", options);
			await show(page, /^Decisions/);
			let card = page.locator(
				'[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]',
			)
				.first();
			await expect(card).toBeVisible();
			await expectClear(page, "[data-plan-decisions-scroll]");

			await card.getByText("In SQLite", { exact: true }).click();
			await expect(page.locator(".decision-save-bar")).toHaveAttribute("data-open");
			await expectClear(page, "[data-plan-decisions-scroll]");
		});

		test("Build", async ({ join, seed }) => {
			// Build opens once there is a build to show.
			let graph: Graph = {
				versions: [{
					number: 1,
					revision: 1,
					planRevision: 0,
					state: "draft",
					definition: {
						tasks: [{
							id: "clear",
							title: "Keep content clear of the bars",
							context: "Phone chrome.",
							goal: "Every pane's text clears the top and bottom bars.",
							acceptance: ["The first line clears the top.", "The last line clears the bottom."],
							dependsOn: [],
						}],
					},
				}],
			};
			await seed(RESPONSIVE_SOURCE, { graph, builds: [failedBuild(graph)] });
			let page = await join("ana", options);
			await show(page, /^Build/);
			await expect(page.getByRole("region", { name: "Build", exact: true })).toBeVisible();
			await expectClear(page, "[data-build-view-scroll]");
		});
	});
}
