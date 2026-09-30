import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

declare global {
	interface Window {
		questionFixture: {
			mount: (mode: "editable" | "readonly" | "disabled") => void;
			release: () => void;
			calls: string[];
		};
	}
}

let script: string;

test.beforeAll(async () => {
	if (typeof Bun === "undefined") throw new Error("Run Playwright through bun --bun");
	let path = fileURLToPath(
		new URL("../../packages/question/src/react/question-view.tsx", import.meta.url),
	);
	let result = await Bun.build({
		entrypoints: [path],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "question-actions-test-binding",
			setup(build) {
				build.onLoad({ filter: /\/question-view\.tsx$/ }, async args => ({
					loader: "tsx",
					contents: await Bun.file(args.path).text() + `
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { AUTH } from "./question-view.test-fixtures";
let fixtureRoot = createRoot(document.querySelector("#fixture"));
let generation = 0;
function ActionsFixture({ mode }) {
	let [submitting, setSubmitting] = useState(false);
	window.questionFixture.release = () => setSubmitting(false);
	let submit = kind => {
		window.questionFixture.calls.push(kind);
		setSubmitting(true);
	};
	return createElement(QuestionView, {
		definition: AUTH,
		drafts: {},
		disabled: mode === "disabled",
		submitting,
		onCancel: mode === "readonly" ? undefined : () => submit("cancel"),
		onDiscard: mode === "readonly" ? undefined : () => submit("discard"),
	});
}
window.questionFixture = {
	calls: [],
	release() {},
	mount(mode) {
		window.questionFixture.calls = [];
		fixtureRoot.render(createElement(ActionsFixture, { key: ++generation, mode }));
	},
};`,
				}));
			},
		}],
	});
	expect(result.success).toBe(true);
	expect(result.outputs).toHaveLength(1);
	script = await result.outputs[0]!.text();
});

async function load(page: Page, mode: "editable" | "readonly" | "disabled") {
	await page.route("**/*", route => route.abort());
	await page.setContent('<main><div id="fixture"></div></main>');
	await page.addScriptTag({ content: script });
	await page.evaluate(mode => window.questionFixture.mount(mode), mode);
	await expect(page.getByText("Decision", { exact: true })).toBeVisible();
}

test("Cancel and Discard open mutually exclusive confirmations", async ({ page }) => {
	await load(page, "editable");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByText("Cancel without answering?", { exact: true })).toBeVisible();
	await expect(page.getByText("Discard this decision?", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Discard decision", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Keep it", exact: true }).click();
	await page.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(page.getByText("Discard this decision?", { exact: true })).toBeVisible();
	await expect(page.getByText("Cancel without answering?", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Yes, cancel", exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Keep it", exact: true }).click();
	await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
	await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeEnabled();
	expect(await page.evaluate(() => window.questionFixture.calls)).toEqual([]);
});

test("held submitting state disables duplicate callbacks and Keep", async ({ page }) => {
	await load(page, "editable");
	await page.getByRole("button", { name: "Discard", exact: true }).click();
	await page.getByRole("button", { name: "Discard decision", exact: true }).click();
	let submitting = page.getByRole("button", { name: "Discarding…", exact: true });
	await expect(submitting).toBeDisabled();
	await expect(page.getByRole("button", { name: "Keep it", exact: true })).toBeDisabled();
	await submitting.evaluate((button: HTMLButtonElement) => button.click());
	expect(await page.evaluate(() => window.questionFixture.calls)).toEqual(["discard"]);
	await page.evaluate(() => window.questionFixture.release());
	await page.getByRole("button", { name: "Keep it", exact: true }).click();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.getByRole("button", { name: "Yes, cancel", exact: true }).click();
	await expect(page.getByRole("button", { name: "Cancelling…", exact: true })).toBeDisabled();
	expect(await page.evaluate(() => window.questionFixture.calls)).toEqual(["discard", "cancel"]);
});

test("read-only and disabled presentations cannot invoke lifecycle callbacks", async ({ page }) => {
	await load(page, "readonly");
	await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
	await page.evaluate(() => window.questionFixture.mount("disabled"));
	await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeDisabled();
	await page.getByRole("button", { name: "Discard", exact: true }).evaluate((
		button: HTMLButtonElement,
	) => button.click());
	expect(await page.evaluate(() => window.questionFixture.calls)).toEqual([]);
});
