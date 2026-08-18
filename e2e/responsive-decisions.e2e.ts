import { authenticate, expect, test } from "./room";
import { storedQuestion } from "../apps/server/src/testing/plan";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { installVisualViewport, setVisualViewport } from "./visual-viewport";

const LONG_WIDGET = "01K0N500000000000000000001";
const LONG_QUESTIONS = [
	{
		id: "01K0N500000000000000000002",
		header: "A deliberately long first decision header that must remain readable on a phone",
		question: "Which responsive contract should govern a narrow collaborative workspace?",
		multiple: false,
		options: [
			{
				id: "01K0N500000000000000000003",
				label: "Preserve every mounted workspace surface while adapting only its presentation",
				description:
					"Plan, Decisions, and Conversation retain their state while their containing layout changes.",
			},
			{
				id: "01K0N500000000000000000004",
				label: "Use the compact layout",
				description: "",
			},
		],
	},
	...Array.from({ length: 5 }, (_, index) => ({
		id: `01K0N5${String(index + 5).padStart(20, "0")}`,
		header: `Question ${index + 2} with a long compact navigation label`,
		question: `What should responsive stage ${index + 2} preserve?`,
		multiple: false,
		options: [{
			id: `01K0N5${String(index + 10).padStart(20, "0")}`,
			label: "Its current state",
			description: "Keep the existing collaborative semantics.",
		}],
	})),
];

const LONG_DEFINITION = { questions: LONG_QUESTIONS };
const LONG_QUESTIONNAIRE = `<Questionnaire id="${LONG_WIDGET}" by="ana">
${
	LONG_QUESTIONS.map(question =>
		`<Question id="${question.id}" header="${question.header}" prompt="${question.question}" multiple="false">
${
			question.options.map(option =>
				`<Option id="${option.id}" label="${option.label}"${
					option.description ? ` description="${option.description}"` : ""
				} />`
			).join("\n")
		}
</Question>`
	).join("\n")
}
</Questionnaire>
`;

function questionnaire(page: import("@playwright/test").Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

for (let viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
	test(`long coarse decisions preserve drafts and focus at ${viewport.width}x${viewport.height}`, async ({ baseURL, browser, room, seed }) => {
		await seed(LONG_QUESTIONNAIRE, {
			revision: 1,
			openQuestions: [{
				definition: LONG_DEFINITION,
				id: LONG_WIDGET,
				model: storedQuestion(LONG_DEFINITION),
				revision: 0,
				widget: LONG_WIDGET,
			}],
		});
		let context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport });
		try {
			await installVisualViewport(context, {
				height: viewport.height,
				offsetLeft: 0,
				offsetTop: 0,
				pageLeft: 0,
				pageTop: 0,
				scale: 1,
				width: viewport.width,
			});
			let page = await context.newPage();
			await authenticate(page, "ana", baseURL!);
			await page.goto(`/channels/${room}`);
			let card = questionnaire(page).filter({ hasText: LONG_QUESTIONS[0]!.header });
			await expect(card).toBeVisible();
			await expectNoHorizontalOverflow(page);

			let firstChoice = card.getByRole("radio", { name: "Use the compact layout" });
			let firstLabel = card.locator("label").filter({ hasText: "Use the compact layout" });
			let firstLabelBox = await firstLabel.boundingBox();
			expect(firstLabelBox).toBeTruthy();
			expect(firstLabelBox!.height).toBeGreaterThanOrEqual(44);
			await expect(firstChoice).toBeVisible();
			let firstChoiceBox = await firstChoice.boundingBox();
			expect(firstChoiceBox).toBeTruthy();
			expect(firstChoiceBox!.width).toBeGreaterThanOrEqual(18);
			expect(firstChoiceBox!.height).toBeGreaterThanOrEqual(18);
			await firstLabel.click();
			await expect(firstChoice).toBeChecked();
			await expect(card.getByText("5 unanswered", { exact: false })).toBeVisible();

			let tabs = card.getByRole("tablist", { name: "Questions" });
			let tabTargets = tabs.getByRole("tab");
			expect(await tabTargets.count()).toBe(LONG_QUESTIONS.length);
			for (
				let box of await tabTargets.evaluateAll(nodes =>
					nodes.map(node => node.getBoundingClientRect().height)
				)
			) expect(box).toBeGreaterThanOrEqual(44);
			expect(await tabs.evaluate(node => node.scrollWidth)).toBeGreaterThan(
				await tabs.evaluate(node => node.clientWidth),
			);

			let next = card.getByRole("button", { name: "Next" });
			let nextBox = await next.boundingBox();
			expect(nextBox).toBeTruthy();
			expect(nextBox!.height).toBeGreaterThanOrEqual(44);
			await next.click();
			await expect(tabTargets.nth(1)).toHaveAttribute("aria-selected", "true");
			await expect(tabTargets.nth(1)).toBeFocused();
			let secondChoice = card.getByRole("radio", { name: "Its current state" });
			await card.getByText("Its current state", { exact: true }).click();
			await expect(secondChoice).toBeChecked();
			await expect(card.getByText("4 unanswered", { exact: false })).toBeVisible();

			await card.getByRole("button", { name: "Back" }).click();
			await expect(tabTargets.first()).toHaveAttribute("aria-selected", "true");
			await expect(tabTargets.first()).toBeFocused();
			await expect(firstChoice).toBeChecked();

			await card.getByRole("button", { name: "Next" }).click();
			await expect(tabTargets.nth(1)).toBeFocused();
			await expect(secondChoice).toBeChecked();
			for (let index = 2; index < LONG_QUESTIONS.length; index++) {
				await card.getByRole("button", { name: "Next" }).click();
				await expect(tabTargets.nth(index)).toHaveAttribute("aria-selected", "true");
				await expect(tabTargets.nth(index)).toBeFocused();
			}
			await expect.poll(() =>
				tabTargets.last().evaluate(node => {
					let tab = node.getBoundingClientRect();
					let list = node.parentElement!.getBoundingClientRect();
					return tab.left >= list.left && tab.right <= list.right;
				})
			).toBe(true);

			let actions = [
				card.getByRole("button", { name: "Back" }),
				card.getByRole("button", { name: "Cancel" }),
				card.getByRole("button", { name: "Submit" }),
			];
			for (let action of actions) {
				await action.scrollIntoViewIfNeeded();
				let geometry = await action.evaluate(node => {
					let box = node.getBoundingClientRect();
					let visual = visualViewport!;
					return {
						height: box.height,
						intersects: box.bottom > visual.offsetTop
							&& box.top < visual.offsetTop + visual.height
							&& box.right > visual.offsetLeft
							&& box.left < visual.offsetLeft + visual.width,
					};
				});
				expect(geometry.height).toBeGreaterThanOrEqual(44);
				expect(geometry.intersects).toBe(true);
			}
			await expect(
				page.getByRole("navigation", { name: "Workspace view" })
					.getByRole("button", { name: /Decisions, 8 unanswered/ }),
			).toBeVisible();

			await tabTargets.first().click();
			let custom = card.getByRole("textbox", { name: /Custom answer for/ });
			await custom.focus();
			await setVisualViewport(page, { event: "resize", height: 360 });
			await expect.poll(() =>
				custom.evaluate(node => {
					let bounds = node.getBoundingClientRect();
					return bounds.bottom <= visualViewport!.offsetTop + visualViewport!.height;
				})
			).toBe(true);
			await expectInsideViewport(custom);
			await expectNoHorizontalOverflow(page);
		} finally {
			await context.close();
		}
	});
}
