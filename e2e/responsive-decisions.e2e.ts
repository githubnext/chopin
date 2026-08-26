import { authenticate, expect, test } from "./room";
import { storedQuestion } from "../apps/server/src/testing/plan";
import { expectInsideViewport, expectNoHorizontalOverflow } from "./responsive";
import { installVisualViewport, setVisualViewport } from "./visual-viewport";

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
					"Plan, Decisions, and Chat retain their state while their containing layout changes.",
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

const LONG_WIDGETS = LONG_QUESTIONS.map((_, index) =>
	`01K0N4${String(index + 1).padStart(20, "0")}`
);
const LONG_QUESTIONNAIRES = LONG_QUESTIONS.map((question, index) =>
	`<Questionnaire id="${LONG_WIDGETS[index]}" by="ana">
<Question id="${question.id}" header="${question.header}" prompt="${question.question}" multiple="false">
${
		question.options.map(option =>
			`<Option id="${option.id}" label="${option.label}"${
				option.description ? ` description="${option.description}"` : ""
			} />`
		).join("\n")
	}
</Question>
</Questionnaire>`
).join("\n");

function questionnaire(page: import("@playwright/test").Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

for (let viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) {
	test(`long independent decisions preserve drafts and focus at ${viewport.width}x${viewport.height}`, async ({ baseURL, browser, room, seed }) => {
		await seed(LONG_QUESTIONNAIRES, {
			revision: 1,
			openQuestions: LONG_QUESTIONS.map((question, index) => {
				let definition = { questions: [question] };
				let id = LONG_WIDGETS[index]!;
				return {
					definition,
					id,
					model: storedQuestion(definition),
					revision: 0,
					widget: id,
				};
			}),
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
			await expect(card.getByRole("textbox", { name: /Custom answer for/ })).toHaveCount(0);
			await expectNoHorizontalOverflow(page);

			let firstChoice = card.getByRole("radio", { name: "Use the compact layout" });
			let firstLabel = card.locator("label").filter({ hasText: "Use the compact layout" });
			let firstLabelBox = await firstLabel.boundingBox();
			expect(firstLabelBox).toBeTruthy();
			expect(firstLabelBox!.height).toBeGreaterThanOrEqual(44);
			await expect(firstChoice).toBeVisible();
			await firstLabel.click();
			await expect(firstChoice).toBeChecked();

			let second = questionnaire(page).filter({ hasText: LONG_QUESTIONS[1]!.header });
			let secondChoice = second.getByRole("radio", { name: "Its current state" });
			await second.getByText("Its current state", { exact: true }).click();
			await expect(secondChoice).toBeChecked();
			await expect(firstChoice).toBeChecked();

			let actions = [
				card.getByRole("button", { name: "Cancel" }),
				card.getByRole("button", { name: "Save answer" }),
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

			let customChoice = card.getByRole("radio", { name: "Write a custom answer" });
			await customChoice.focus();
			await page.keyboard.press("Space");
			let custom = card.getByRole("textbox", { name: /Custom answer for/ });
			await expect(custom).toBeFocused();
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
