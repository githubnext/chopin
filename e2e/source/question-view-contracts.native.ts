import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { questionViewContractsBinding } from "./question-view-contracts.fixture";
import type { Page } from "@playwright/test";

let script: string;
let stylesheet: string;

test.beforeAll(async () => {
	if (typeof Bun === "undefined") throw new Error("Run Playwright through bun --bun");
	let entry = fileURLToPath(
		new URL("../../packages/editor/src/widgets/questionnaire.tsx", import.meta.url),
	);
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "actual-question-view-contracts-binding",
			setup(build) {
				build.onLoad({ filter: /\/widgets\/questionnaire\.tsx$/ }, async args => ({
					loader: "tsx",
					contents: await Bun.file(args.path).text() + "\n" + questionViewContractsBinding,
				}));
			},
		}],
	});
	expect(result.success, JSON.stringify(result.logs)).toBe(true);
	let outputs = result.outputs.filter(output => output.path.endsWith(".js"));
	expect(outputs).toHaveLength(1);
	script = await outputs[0]!.text();
	let assets = fileURLToPath(new URL("../../apps/web/dist/assets/", import.meta.url));
	let files = await readdir(assets);
	let names = files.filter(name => /^index-.*\.css$/.test(name));
	let editor = files.filter(name => /^plan-editor-.*\.css$/.test(name));
	expect(names).toHaveLength(1);
	expect(editor).toHaveLength(1);
	stylesheet = (await Promise.all([names[0]!, editor[0]!].map(name =>
		readFile(assets + name, "utf8")
	))).join("\n");
	expect(stylesheet).toContain(".question-choice-row");
	expect(stylesheet).toContain(".choice-control");
});

async function load(
	page: Page,
	mode: "open" | "empty" | "linked" | "unlinked" | "discarded-single" | "discarded-multiple",
) {
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	let url = "https://question-view-contracts.invalid/";
	await page.route(
		"**/*",
		route =>
			route.request().url() === url && route.request().isNavigationRequest()
				? route.fulfill({
					contentType: "text/html",
					body:
						'<!doctype html><html><body><main class="plan p-6"><div class="w-80" id="fixture"></div><button id="outside">Outside card</button></main></body></html>',
				})
				: route.abort(),
	);
	await page.goto(url);
	expect(await page.evaluate(() => ({ mode: document.compatMode, secure: window.isSecureContext })))
		.toEqual({ mode: "CSS1Compat", secure: true });
	await page.addStyleTag({ content: stylesheet });
	await page.addScriptTag({ content: script });
	await page.evaluate(mode => window.questionViewContractsFixture.mount(mode), mode);
	if (mode === "discarded-single" || mode === "discarded-multiple") {
		await expect(page.getByText(/^Discarded by @ben —/)).toBeVisible();
	} else {
		await expect(page.getByRole("heading", { name: "Auth", level: 4, exact: true })).toBeVisible();
	}
	return errors;
}

test("the current open card combines its header, human choice, people and actions", async ({ page }) => {
	let errors = await load(page, "open");
	let card = page.getByRole("article", { name: "Decision", exact: true });
	await expect(card.getByText("Decision", { exact: true })).toBeVisible();
	await expect(card.getByRole("heading", { name: "Auth", level: 4, exact: true })).toBeVisible();
	let prompt = card.getByText("What auth system should we use?", { exact: true });
	await expect(prompt).toBeVisible();
	expect(await prompt.evaluate(element => element.tagName)).toBe("P");
	await expect(card.getByRole("heading", { name: "What auth system should we use?" })).toHaveCount(
		0,
	);
	let choices = card.getByRole("group", { name: "Auth", exact: true });
	expect(await choices.evaluate(element => element.tagName)).toBe("FIELDSET");
	await expect(choices.getByRole("radio")).toHaveCount(2);
	await expect(choices.getByRole("radio", { name: "GitHub Apps", exact: true })).toBeChecked();
	await expect(choices.getByRole("radio", { name: "Auth0", exact: true })).not.toBeChecked();
	await expect(card.getByText("from chat", { exact: true })).toHaveCount(0);
	await expect(card.getByRole("group", { name: "In this decision: ana, bea", exact: true }))
		.toBeVisible();
	await expect(card.getByRole("radio", { name: "Write a custom answer", exact: true }))
		.toBeVisible();
	await expect(card.getByRole("textbox", { name: "Custom answer for Auth", exact: true }))
		.toHaveCount(0);
	await expect(card.getByRole("button", { name: "Add another option", exact: true })).toBeEnabled();
	let save = card.getByRole("button", { name: "Save answer", exact: true });
	await expect(save).toBeEnabled();
	await choices.getByRole("radio", { name: "Auth0", exact: true }).check();
	expect((await page.evaluate(() => window.questionViewContractsFixture.snapshot())).draft.choice)
		.toBe("a");
	await save.click();
	await card.getByRole("button", { name: "Discard", exact: true }).click();
	await expect(card.getByText("Discard this decision?", { exact: true })).toBeVisible();
	expect((await page.evaluate(() => window.questionViewContractsFixture.snapshot())).discarded)
		.toBe(0);
	await card.getByRole("button", { name: "Discard decision", exact: true }).click();
	expect(await page.evaluate(() => window.questionViewContractsFixture.snapshot())).toMatchObject({
		submitted: 1,
		discarded: 1,
	});
	await card.getByRole("button", { name: "Keep it", exact: true }).click();
	await expect(card.getByText("Discard this decision?", { exact: true })).toHaveCount(0);
	await card.getByRole("button", { name: "Add another option", exact: true }).click();
	await expect(card.getByRole("textbox", { name: "New option", exact: true })).toBeFocused();
	expect(errors).toEqual([]);
});

test("Save answer requires a chosen option or a nonempty current custom answer", async ({ page }) => {
	let errors = await load(page, "empty");
	let save = page.getByRole("button", { name: "Save answer", exact: true });
	await expect(save).toBeDisabled();
	await expect(page.getByRole("radio", { name: "GitHub Apps", exact: true })).not.toBeChecked();
	await page.getByRole("radio", { name: "Write a custom answer", exact: true }).check();
	let custom = page.getByRole("textbox", { name: "Custom answer for Auth", exact: true });
	await expect(custom).toBeVisible();
	await expect(save).toBeDisabled();
	await custom.fill("Another auth approach");
	await expect(save).toBeEnabled();
	expect((await page.evaluate(() => window.questionViewContractsFixture.snapshot())).draft)
		.toMatchObject({ mode: "custom", custom: "Another auth approach", choice: null });
	await save.click();
	expect((await page.evaluate(() => window.questionViewContractsFixture.snapshot())).submitted)
		.toBe(1);
	expect(errors).toEqual([]);
});

test("Related preserves separate heading and counted name and forwards parent-section events", async ({ page }) => {
	let errors = await load(page, "linked");
	let related = page.getByRole("button", {
		name: "What auth system should we use? — show in plan, 2 places",
		exact: true,
	});
	await expect(related).toBeVisible();
	await expect(related).toHaveAttribute("data-ace-question-id", "q");
	await expect(related.getByRole("heading")).toHaveCount(0);
	expect(
		await page.getByRole("heading", { name: "Auth", exact: true }).evaluate(element =>
			element.closest("button") === null
		),
	).toBe(true);
	await page.mouse.move(0, 0);
	await page.evaluate(() => window.questionViewContractsFixture.resetEvents());
	await related.hover();
	expect((await page.evaluate(() => window.questionViewContractsFixture.snapshot())).events)
		.toEqual([{ kind: "enter", question: "q" }]);
	await page.mouse.move(0, 0);
	expect((await page.evaluate(() => window.questionViewContractsFixture.snapshot())).events)
		.toEqual([{ kind: "enter", question: "q" }, { kind: "leave", question: "q" }]);
	await page.evaluate(() => window.questionViewContractsFixture.resetEvents());
	await related.focus();
	await page.getByRole("button", { name: "Outside card", exact: true }).focus();
	expect((await page.evaluate(() => window.questionViewContractsFixture.snapshot())).events)
		.toEqual([{ kind: "enter", question: "q" }, { kind: "leave", question: "q" }]);
	await page.evaluate(() => window.questionViewContractsFixture.resetEvents());
	await related.click();
	expect((await page.evaluate(() => window.questionViewContractsFixture.snapshot())).events
		.filter(event => event.kind === "select")).toEqual([{ kind: "select", question: "q" }]);
	expect(errors).toEqual([]);
});

test("an unlinked prompt remains inert prose with no advertised Related destination", async ({ page }) => {
	let errors = await load(page, "unlinked");
	await expect(page.getByRole("button", { name: /show in plan/ })).toHaveCount(0);
	let prompt = page.getByText("What auth system should we use?", { exact: true });
	expect(
		await prompt.evaluate(element => ({
			tag: element.tagName,
			linked: !!element.closest("button"),
		})),
	)
		.toEqual({ tag: "P", linked: false });
	await prompt.click();
	expect((await page.evaluate(() => window.questionViewContractsFixture.snapshot())).events
		.filter(event => event.kind === "select")).toEqual([]);
	expect(errors).toEqual([]);
});

test("a discarded single card attributes ben and names its prompt exactly once", async ({ page }) => {
	let errors = await load(page, "discarded-single");
	let card = page.getByRole("article", { name: "Decision", exact: true });
	await expect(
		card.getByText("Discarded by @ben — What auth system should we use?", { exact: true }),
	)
		.toBeVisible();
	let visible = await card.innerText();
	expect(visible.match(/What auth system should we use\?/g)).toHaveLength(1);
	expect(visible.match(/Discarded by @ben/g)).toHaveLength(1);
	await expect(card.getByText(/Cancelled|Answered by/)).toHaveCount(0);
	await expect(card.getByRole("radio")).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Save answer", exact: true })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("a discarded multi-card names every original question and ben exactly once", async ({ page }) => {
	let errors = await load(page, "discarded-multiple");
	let card = page.getByRole("article", { name: "Decision", exact: true });
	await expect(card.getByText(
		"Discarded by @ben — What auth system should we use?, What belongs in the first cut?",
		{ exact: true },
	)).toBeVisible();
	let visible = await card.innerText();
	expect(visible.match(/What auth system should we use\?/g)).toHaveLength(1);
	expect(visible.match(/What belongs in the first cut\?/g)).toHaveLength(1);
	expect(visible.match(/Discarded by @ben/g)).toHaveLength(1);
	await expect(card.getByText(/Cancelled|Answered by/)).toHaveCount(0);
	await expect(card.getByRole("radio")).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Save answer", exact: true })).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
	expect(errors).toEqual([]);
});
