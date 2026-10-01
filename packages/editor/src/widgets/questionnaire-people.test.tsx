import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuestionnaireCard } from "./questionnaire";
import { DECIDED, META } from "./questionnaire-metadata.test-fixtures";

test("an open card keeps durable people when nobody is currently editing", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: false,
		connected: true,
		meta: { ...META, involved: ["ana", "ben"], status: "reopened" },
		value: {
			...DECIDED,
			questions: [{ ...DECIDED.questions[0]!, answer: undefined, choices: undefined }],
		},
	}));
	expect(markup).toContain('aria-label="In this decision: ana, ben"');
});

test("durable people deduplicate and retain all accessible handles beyond three avatars", () => {
	let markup = renderToStaticMarkup(createElement(QuestionnaireCard, {
		canEdit: false,
		connected: true,
		meta: {
			...META,
			involved: ["ana", "ana", "ben", "cam", "dee", "eli", "flo", "gia", "hal", "ian"],
			status: "reopened",
		},
		value: DECIDED,
	}));
	expect(markup).toContain(
		'aria-label="In this decision: ana, ben, cam, dee, eli, flo, gia, hal, ian"',
	);
	expect(markup).toContain(">+6<");
	expect((markup.match(/<img/g) ?? []).length).toBe(3);
});
