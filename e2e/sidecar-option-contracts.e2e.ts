import { authenticate, content, expect, roomPath, test } from "./room";
import { read, restore } from "../packages/question/src/draft";

import type { Page } from "@playwright/test";
import type { Definition } from "../packages/question/src/schema";

/** Long enough to be marked: the injector wants twenty characters. */
const PROSE = "Room state lives on disk as MDX beside the transcript.\n";

const WIDGET = "01K0N4TR8K7JGM4R1J7PW4R8YJ";

const QUESTION = "01K0N4V4E7Y6P4MJ5WD8XZF3B2";

const OPTION = "01K0N4W3B7P27CBAEC7A8C8WEA";

const LEGACY_CUSTOM_ANSWER = `<Questionnaire id="${WIDGET}" by="ana">
<Question id="${QUESTION}" header="Rollout" prompt="How should we deploy?" multiple="false">
<Option id="${OPTION}" label="Canary" />
<Answer value="Only collaborative anchors" />
</Question>
</Questionnaire>
`;

function questionnaire(page: import("@playwright/test").Page) {
	return page.locator('[data-document-view="decisions"] article[data-plan-sidecar-questionnaire]');
}

test("adding an option shows it to everyone and keeps a selection", async ({ join, seed }) => {
	await seed(PROSE);
	let ana = await join("ana");
	let ben = await join("ben");
	for (let page of [ana, ben]) await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = (page: Page) =>
		questionnaire(page).filter({
			has: page.getByRole("heading", { name: "Where should room state live?" }),
		});

	let selected = card(ben).getByRole("radio", { name: "In SQLite" });
	await card(ben).getByText("In SQLite", { exact: true }).click();
	await expect(selected).toBeChecked();
	await card(ana).getByRole("button", { name: "Add an option", exact: true }).click();
	await card(ana).getByRole("textbox", { name: "New option" }).fill("In PostgreSQL");
	await ana.keyboard.press("Enter");

	await expect(card(ben).getByRole("radio", { name: "In PostgreSQL" })).toBeVisible();
	await expect(card(ben).getByRole("radio", { name: "In SQLite" })).toBeChecked();
	await expect(card(ana).getByRole("textbox", { name: "New option" })).toHaveCount(0);
	await expect(card(ana).getByRole("button", { name: "Add an option", exact: true })).toBeFocused();

	for (let [writer, label] of [[ben, "In MySQL"], [ana, "In files"]] as const) {
		await card(writer).getByRole("button", { name: "Add an option", exact: true }).click();
		let field = card(writer).getByRole("textbox", { name: "New option" });
		await field.fill(label);
		await field.press("Enter");
		await expect(field).toHaveCount(0);
		for (let page of [ana, ben]) {
			await expect(card(page).getByRole("radio", { name: label, exact: true })).toBeVisible();
			await expect(
				card(page).getByRole("radio", {
					name: "In SQLite Transactional, but opaque without a client.",
					exact: true,
				}),
			).toBeChecked();
		}
	}
	for (let page of [ana, ben]) {
		await expect(card(page).getByRole("radio")).toHaveCount(5);
		for (let label of ["In PostgreSQL", "In MySQL", "In files"]) {
			await expect(card(page).getByRole("radio", { name: label, exact: true })).not.toBeChecked();
		}
		await expect(card(page).getByRole("button", { name: "Add an option", exact: true }))
			.toBeEnabled();
	}
});

test("adding an option leaves an unanswered decision unselected after refresh", async ({ join, page, seed }) => {
	await seed(PROSE);
	let snapshots: Array<{ definition: Definition; model: number[] }> = [];
	let definition: Definition | undefined;
	let changed = 0;
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as {
					kind?: string;
					open?: boolean;
					definition?: Definition;
					model?: number[];
				};
				if (
					frame.kind === "question:option-added" && frame.definition
					&& frame.definition.questions[0]?.question === "Where should room state live?"
				) {
					changed++;
					definition = frame.definition;
				}
				if (
					frame.kind === "question:open" && frame.open && frame.definition && frame.model
					&& frame.definition.questions[0]?.question === "Where should room state live?"
				) {
					definition = frame.definition;
					snapshots.push({ definition: frame.definition, model: frame.model });
				}
			}
			route.send(message);
		});
	});

	let ben = await join("ben");
	await ben.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(ben).filter({
		has: ben.getByRole("heading", { name: "Where should room state live?" }),
	});
	let options = card.getByRole("radio");
	let save = card.getByRole("button", { name: "Save", exact: true });
	await expect(options).toHaveCount(2);
	await expect.poll(() => snapshots.length).toBeGreaterThan(0);
	let unanswered = () => {
		let snapshot = snapshots.at(-1)!;
		let current = definition!;
		let question = current.questions[0]!;
		let draft = read(restore(snapshot.model, current), current)[question.id];
		expect(draft?.choice).toBeNull();
		expect(draft?.mode).toBe("choices");
		expect(Object.values(draft?.options ?? {})).toEqual(
			Array.from({ length: question.options.length }, () => false),
		);
	};
	let checkVisible = async (count: number) => {
		await expect(options).toHaveCount(count);
		for (let option of await options.all()) await expect(option).not.toBeChecked();
		await expect(save).toBeDisabled();
	};
	let ana = await join("ana");
	await ana.getByRole("button", { name: /^Decisions/ }).click();
	let author = questionnaire(ana).filter({
		has: ana.getByRole("heading", { name: "Where should room state live?" }),
	});
	let add = async (label: string) => {
		await author.getByRole("button", { name: "Add an option", exact: true }).click();
		let field = author.getByRole("textbox", { name: "New option" });
		await field.fill(label);
		await ana.keyboard.press("Enter");
		await expect(field).toHaveCount(0);
	};
	for (let [index, label] of ["In PostgreSQL", "In MySQL", "In files", "In memory"].entries()) {
		await add(label);
		await expect(options).toHaveCount(index + 3);
	}
	await expect.poll(() => definition?.questions[0]?.options.length).toBe(6);
	let beforeIds = definition!.questions[0]!.options.map(option => option.id);
	unanswered();
	await checkVisible(6);
	let previousChanges = changed;

	await add("In a repository");

	await expect.poll(() => changed).toBeGreaterThan(previousChanges);
	await expect.poll(() => definition?.questions[0]?.options.length).toBe(7);
	let after = definition!;
	expect(after.questions[0]!.options.map(option => option.id).slice(0, 6)).toEqual(
		beforeIds,
	);
	expect(after.questions[0]!.options[6]?.label).toBe("In a repository");
	unanswered();
	await checkVisible(7);
	await expect(card.getByText("· Suggested in Chat", { exact: true })).toHaveCount(0);

	let previousSnapshots = snapshots.length;
	await ben.reload();
	await ben.getByRole("button", { name: /^Decisions/ }).click();
	await expect.poll(() => snapshots.length).toBeGreaterThan(previousSnapshots);
	await expect.poll(() => definition?.questions[0]?.options.length).toBe(7);
	unanswered();
	await checkVisible(7);
});

test("a duplicate option is refused inline", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({
		has: page.getByRole("heading", { name: "Where should room state live?" }),
	});
	await card.getByRole("button", { name: "Add an option", exact: true }).click();
	await card.getByRole("textbox", { name: "New option" }).fill("in sqlite");
	await page.keyboard.press("Enter");

	await expect(card.getByRole("alert")).toContainText("That option already exists");
	await expect(card.getByRole("textbox", { name: "New option" })).toHaveValue("in sqlite");
});

test("a read-only reader cannot change a decision", async ({ baseURL, browser, join, room, seed }) => {
	await seed(PROSE);
	await join("ana");
	let context = await browser.newContext({ baseURL });
	try {
		let reader = await context.newPage();
		await authenticate(reader, "readonly", baseURL!);
		await reader.goto(roomPath(room));
		await expect(content(reader)).toHaveAttribute("contenteditable", "false");
		await reader.getByRole("button", { name: /^Decisions/ }).click();
		let card = questionnaire(reader).first();
		await expect(card).toBeVisible();
		await expect(card.getByRole("button", { name: "Add an option", exact: true })).toBeDisabled();
		let options = card.getByRole("radio");
		await expect(options).toHaveCount(2);
		for (let option of await options.all()) await expect(option).toBeDisabled();
		for (let name of ["Save", "Discard", "Cancel"]) {
			await expect(card.getByRole("button", { name, exact: true })).toHaveCount(0);
		}
	} finally {
		await context.close();
	}
});

test("Escape returns from adding an option to its trigger", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	let decisions = page.getByRole("button", { name: /^Decisions/ });
	await decisions.click();
	let card = questionnaire(page).filter({
		has: page.getByRole("heading", { name: "Where should room state live?" }),
	});
	let trigger = card.getByRole("button", { name: "Add an option", exact: true });
	await trigger.click();
	let field = card.getByRole("textbox", { name: "New option" });
	await expect(field).toBeFocused();
	await page.keyboard.press("Escape");

	await expect(field).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await expect(page.locator('[data-document-view="decisions"]')).toBeVisible();
	await expect(decisions).toHaveAttribute("aria-pressed", "true");
});

test("native radio keyboard focus is visible on its full option row", async ({ join, seed }) => {
	await seed(PROSE);
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({
		has: page.getByRole("heading", { name: "Where should room state live?" }),
	});
	let first = card.getByRole("radio", { name: "On disk as MDX" });
	let second = card.getByRole("radio", { name: "In SQLite" });
	await first.focus();
	await page.keyboard.press("ArrowDown");

	await expect(second).toBeFocused();
	await expect(second).toBeChecked();
	expect(await second.evaluate(element => element.matches(":focus-visible"))).toBe(true);
	let row = second.locator("xpath=ancestor::label[1]");
	expect(await row.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
});

test("legacy saved custom answers remain readable", async ({ join, seed }) => {
	await seed(`${PROSE}\n${LEGACY_CUSTOM_ANSWER}`, {
		questions: [{
			id: WIDGET,
			definition: {
				questions: [{
					id: QUESTION,
					header: "Rollout",
					question: "How should we deploy?",
					multiple: false,
					options: [{ id: OPTION, label: "Canary", description: "" }],
				}],
			},
			status: "answered",
			answers: { [QUESTION]: "Only collaborative anchors" },
			resolver: "ana",
		}],
	});
	let page = await join("ana");
	await page.getByRole("button", { name: /^Decisions/ }).click();
	let card = questionnaire(page).filter({
		has: page.getByText("How should we deploy?", { exact: true }),
	});
	await page.getByRole("button", { name: /resolved/ }).click();

	await expect(card).toContainText("Only collaborative anchors");
	await expect(card.getByRole("radio")).toHaveCount(0);
	await expect(card.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
});
