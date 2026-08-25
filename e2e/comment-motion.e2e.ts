import { content, expect, test } from "./room";

const PROSE = "Room state lives on disk as MDX beside the transcript.\n";
const TWO_BLOCKS = `${PROSE}\nA second block remains after the marked passage.\n`;
const QUOTED = "Room state lives on disk as MDX beside the trans";

function commentButton(page: import("@playwright/test").Page) {
	return page.getByRole("button", { name: /Comment on “/ });
}

async function secondThread(page: import("@playwright/test").Page) {
	await content(page).locator("p").nth(1).selectText();
	await page.getByRole("button", { name: "Comment on this passage", exact: true }).click();
	let draft = page.getByRole("dialog", { name: "New comment" });
	await draft.getByPlaceholder("Comment on this passage…").fill("Keep this block as well.");
	await draft.getByRole("button", { name: "Comment" }).click();
	await expect.poll(() => commentButton(page).count()).toBe(2);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
}

test("comment preview motion retains one tooltip through pointer interruption", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");

	let button = commentButton(page);
	await expect(button).toBeVisible();
	let firstMount = page.evaluate(
		quote =>
			new Promise<{ role: string | null; visibility: string }>(
				resolve => {
					let observer = new MutationObserver(records => {
						for (let record of records) {
							for (let node of record.addedNodes) {
								if (!(node instanceof HTMLElement)) continue;
								let candidates = [
									node,
									...node.querySelectorAll<HTMLElement>('[aria-hidden="true"]'),
								];
								let preview = candidates.find(element =>
									element.getAttribute("aria-hidden") === "true"
									&& element.querySelector("p")?.textContent === quote
								);
								if (!preview) continue;
								observer.disconnect();
								resolve({
									role: preview.getAttribute("role"),
									visibility: preview.style.visibility,
								});
								return;
							}
						}
					});
					observer.observe(document.body, { childList: true, subtree: true });
				},
			),
		QUOTED,
	);
	let initial = page.evaluate(() =>
		new Promise<{ opacity: string; transform: string }>(resolve => {
			let observer = new MutationObserver(() => {
				let tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
				if (!tooltip) return;
				observer.disconnect();
				let style = getComputedStyle(tooltip);
				resolve({ opacity: style.opacity, transform: style.transform });
			});
			observer.observe(document.body, { childList: true, subtree: true });
		})
	);
	await button.hover();
	expect(await firstMount).toEqual({ role: null, visibility: "hidden" });
	let preview = page.getByRole("tooltip", { includeHidden: true });
	await expect(preview).toContainText(QUOTED);
	expect(await initial).not.toEqual({ opacity: "1", transform: "none" });
	await expect(preview).toHaveCSS("opacity", "1");
	let previewId = await preview.getAttribute("id");
	expect(previewId).not.toBeNull();
	await expect(button).toHaveAttribute("aria-describedby", previewId!);

	let closing = preview.evaluate(element =>
		new Promise<void>(resolve => {
			let observer = new MutationObserver(() => {
				if (element.getAttribute("aria-hidden") !== "true") return;
				observer.disconnect();
				resolve();
			});
			observer.observe(element, { attributes: true });
		})
	);
	await page.getByRole("button", { name: "Document", exact: true }).hover();
	await closing;
	await expect(button).not.toHaveAttribute("aria-describedby", previewId!);
	await expect(preview).toHaveAttribute("aria-hidden", "true");
	await expect(preview).toHaveAttribute("inert", "");

	await button.hover();
	await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveCount(1);
	await expect(preview).not.toHaveAttribute("aria-hidden", "true");
	await expect(preview).not.toHaveAttribute("inert", "");
	await expect(preview).toHaveCSS("opacity", "1");
});

test("comment preview motion settles for keyboard and reactive reduced motion", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let button = commentButton(page);

	await page.keyboard.press("Alt");
	await button.focus();
	let preview = page.getByRole("tooltip");
	await expect(preview).toBeVisible();
	await expect(preview).toHaveCSS("transition-duration", "0s");
	await page.keyboard.press("Escape");
	await expect(preview).toHaveCount(0);

	await button.evaluate(element => element.blur());
	await page.emulateMedia({ reducedMotion: "no-preference" });
	let pointerEntry = page.evaluate(() =>
		new Promise<{ opacity: string; transitionDuration: string }>(resolve => {
			let observer = new MutationObserver(() => {
				let tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
				if (!tooltip) return;
				observer.disconnect();
				let style = getComputedStyle(tooltip);
				resolve({ opacity: style.opacity, transitionDuration: style.transitionDuration });
			});
			observer.observe(document.body, { childList: true, subtree: true });
		})
	);
	await button.hover();
	let pointerStart = await pointerEntry;
	expect(pointerStart.opacity).not.toBe("1");
	expect(pointerStart.transitionDuration).not.toBe("0s");
	preview = page.getByRole("tooltip", { includeHidden: true });
	await expect(preview).toHaveCSS("opacity", "1");
	let closing = preview.evaluate(element =>
		new Promise<void>(resolve => {
			let observer = new MutationObserver(() => {
				if (element.getAttribute("aria-hidden") !== "true") return;
				observer.disconnect();
				resolve();
			});
			observer.observe(element, { attributes: true });
		})
	);
	await page.getByRole("button", { name: "Document", exact: true }).hover();
	await closing;
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(preview).toHaveCount(0);
});

test("comment preview abandons an unmeasurable placement", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let button = commentButton(page);
	await page.addStyleTag({ content: ".plan-comment-preview { display: none !important; }" });

	await button.hover();

	await expect(page.locator(".plan-comment-preview")).toHaveCount(0);
	await expect(button).not.toHaveAttribute("aria-describedby");
});

test("moving directly between comment markers gives the next preview its own entrance", async ({ join, seed }) => {
	await seed(TWO_BLOCKS);
	let page = await join("ana");
	await secondThread(page);
	let buttons = commentButton(page);
	let first = buttons.first();
	let second = buttons.last();
	await first.hover();
	let firstPreview = page.getByRole("tooltip");
	await expect(firstPreview).toHaveCSS("opacity", "1");
	let firstId = await firstPreview.getAttribute("id");

	let nextEntrance = page.evaluate(
		previousId =>
			new Promise<{ id: string; opacity: string; transitionDuration: string }>(resolve => {
				let observer = new MutationObserver(() => {
					let tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
					if (!tooltip || tooltip.id === previousId) return;
					observer.disconnect();
					let style = getComputedStyle(tooltip);
					resolve({
						id: tooltip.id,
						opacity: style.opacity,
						transitionDuration: style.transitionDuration,
					});
				});
				observer.observe(document.body, {
					attributes: true,
					childList: true,
					characterData: true,
					subtree: true,
				});
			}),
		firstId,
	);
	await second.hover();
	let entrance = await nextEntrance;
	expect(entrance.id).not.toBe(firstId);
	expect(entrance.opacity).not.toBe("1");
	expect(entrance.transitionDuration).not.toBe("0s");
	await expect(page.getByRole("tooltip")).toContainText("A second block remains");
	await expect(page.getByRole("tooltip")).toHaveCSS("opacity", "1");
	await expect(page.getByRole("tooltip", { includeHidden: true })).toHaveCount(1);
});
