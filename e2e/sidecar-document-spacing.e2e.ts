import { authenticate, content, expect, roomPath, test } from "./room";
import { seedCardGapChannel } from "./sidecar-spacing-database";

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";

const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";

const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";

const SECOND_QUESTION = "01K0N4W3B7P27CBAEC7A8C8WEB";

const SECOND_OPTION = "01K0N4W3B7P27CBAEC7A8C8WEC";

const SECOND_WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YK";

const ADJACENT_CARDS = `<Questionnaire id="${WIDGET}" by="ana">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
</Question>
</Questionnaire>
<Questionnaire id="${SECOND_WIDGET}" by="ana">
<Question id="${SECOND_QUESTION}" header="Scope" prompt="What belongs in the first cut?" multiple="false">
<Option id="${SECOND_OPTION}" label="Anchors" />
</Question>
</Questionnaire>`;

test("adjacent decision cards keep at most one line of space around one empty paragraph", async ({ baseURL, page, room, seed }) => {
	await seed(ADJACENT_CARDS);
	await authenticate(page, "ana", baseURL!);
	await page.goto(roomPath(room));
	await page.getByRole("button", { name: "Document", exact: true }).click();
	let editor = content(page);
	let cards = editor.locator(
		`:scope > :is([data-plan-questionnaire="${WIDGET}"], [data-plan-questionnaire="${SECOND_WIDGET}"])`,
	);
	await expect(cards).toHaveCount(2);
	let gap = async () => {
		let first = await cards.nth(0).boundingBox();
		let second = await cards.nth(1).boundingBox();
		if (!first || !second) throw new Error("decision card geometry unavailable");
		return second.y - first.y - first.height;
	};
	let lineHeight = await editor.evaluate(element =>
		Number.parseFloat(getComputedStyle(element).lineHeight)
	);
	expect(await gap()).toBeLessThanOrEqual(lineHeight);

	let interstitial = (count: number) =>
		cards.nth(0).evaluate((host, count) => {
			let second = host.nextElementSibling;
			if (!second?.hasAttribute("data-plan-questionnaire")) {
				throw new Error("the seeded cards are not adjacent");
			}
			let paragraphs = Array.from({ length: count }, () => {
				let paragraph = document.createElement("p");
				paragraph.dir = "auto";
				let lineBreak = document.createElement("br");
				lineBreak.setAttribute("data-lexical-managed-linebreak", "true");
				paragraph.append(lineBreak);
				return paragraph;
			});
			host.after(...paragraphs);
			let firstBox = host.getBoundingClientRect();
			let secondBox = second.getBoundingClientRect();
			let heights = paragraphs.map(paragraph => paragraph.getBoundingClientRect().height);
			paragraphs.forEach(paragraph => paragraph.remove());
			return { gap: secondBox.top - firstBox.bottom, heights };
		}, count);
	let single = await interstitial(1);
	expect(single.heights).toEqual([lineHeight]);
	expect(single.gap).toBeLessThanOrEqual(lineHeight);
});

test("retained empty paragraphs between decisions compact after sync and reload", async ({ baseURL, page, room }) => {
	await seedCardGapChannel(Number(new URL(baseURL!).port), room, ADJACENT_CARDS);
	await authenticate(page, "ana", baseURL!);
	await page.goto(roomPath(room));
	let inspect = async () => {
		await page.getByRole("button", { name: "Document", exact: true }).click();
		let editor = content(page);
		await expect.poll(() =>
			editor.evaluate((root, ids) => {
				let children = [...root.children];
				let first = children.findIndex(node =>
					node.getAttribute("data-plan-questionnaire") === ids[0]
				);
				let second = children.findIndex(node =>
					node.getAttribute("data-plan-questionnaire") === ids[1]
				);
				return children.slice(first + 1, second).filter(node => node.tagName === "P").length;
			}, [WIDGET, SECOND_WIDGET])
		).toBe(1);
		let cards = editor.locator(
			`:scope > :is([data-plan-questionnaire="${WIDGET}"], [data-plan-questionnaire="${SECOND_WIDGET}"])`,
		);
		let first = await cards.nth(0).boundingBox();
		let second = await cards.nth(1).boundingBox();
		if (!first || !second) throw new Error("decision card geometry unavailable");
		let lineHeight = await editor.evaluate(element =>
			Number.parseFloat(getComputedStyle(element).lineHeight)
		);
		expect(second.y - first.y - first.height).toBeLessThanOrEqual(lineHeight);
	};
	await inspect();
	let caret = content(page).locator(`[data-plan-questionnaire="${WIDGET}"] + p`);
	await caret.click();
	await page.keyboard.type("x");
	await expect(caret).toHaveText("x");
	await page.keyboard.press("Backspace");
	await expect(caret).toHaveText("");
	await page.reload();
	await inspect();
});
