/**
 * A Planner-proposed investigation lands under the passage it concerns, through
 * the real host tool, placement and sockets, against the `AGENT=on` fake harness.
 */
import { chatInput } from "./chat-input";
import { content, expect, test } from "./room";

test("a Planner-proposed investigation card sits directly under its related paragraph", async ({ join, seed }) => {
	await seed(
		"# Harness investigation\n\nCold start is slow on large repositories.\n\nNext we ship the cache.\n",
	);
	let page = await join("ana");
	let chat = page.getByRole("complementary", { includeHidden: true, name: "Chat" });
	await chatInput(chat).fill("@chopin INVESTIGATE-ANCHOR how slow is cold start?");
	await chat.getByRole("button", { name: "Send message" }).click();

	await expect(chat.getByText("Proposed an investigation, anchored.")).toBeVisible({
		timeout: 20_000,
	});
	let card = content(page).locator("[data-plan-investigation]");
	await expect(card).toHaveCount(1);
	await expect(page.getByRole("article", { name: "Investigation", exact: true }))
		.toContainText("Measure cold start time");
	let neighbours = await card.evaluate(element => [
		element.previousElementSibling?.textContent ?? "",
		element.nextElementSibling?.textContent ?? "",
	]);
	expect(neighbours).toEqual([
		"Cold start is slow on large repositories.",
		"Next we ship the cache.",
	]);
});

test("Build names its required investigation and opens its card", async ({ join, seed }) => {
	await seed("# Cache plan\n\nCold start is slow on large repositories.\n\nChoose a cache.\n");
	let page = await join("ana");
	let chat = page.getByRole("complementary", { includeHidden: true, name: "Chat" });
	await chatInput(chat).fill("@chopin INVESTIGATE-ANCHOR REQUIRED measure cold start");
	await chat.getByRole("button", { name: "Send message" }).click();
	let build = page.getByRole("button", { name: "Build plan", exact: true });
	await expect(build).toHaveAccessibleDescription("Waiting on 1 investigation");
	await expect(build).toContainText("Waiting on 1 investigation");
	let card = page.getByRole("article", { name: "Investigation", exact: true });
	await expect(card).toContainText("Required before building");
	await expect(card).toContainText("Choose the cache approach from measured cold start times.");
	await build.click({ force: true });
	await expect(card).toBeFocused();
	await expect(card).toBeInViewport();
	await expect(card.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
});

test("a removed investigation cannot become an invisible Build requirement", async ({ join, seed }) => {
	await seed("# Cache plan\n\nCold start is slow on large repositories.\n\nChoose a cache.\n");
	let page = await join("ana");
	let chat = page.getByRole("complementary", { includeHidden: true, name: "Chat" });
	await chatInput(chat).fill("@chopin INVESTIGATE-ANCHOR measure cold start");
	await chat.getByRole("button", { name: "Send message" }).click();
	let card = page.getByRole("article", { name: "Investigation", exact: true });
	await expect(card).toBeVisible();
	await card.getByRole("button", { name: "Remove investigation", exact: true }).click();
	await expect(card).toHaveCount(0);
	await chatInput(chat).fill("@chopin REQUIRE-REMOVED-INVESTIGATION");
	await chat.getByRole("button", { name: "Send message" }).click();
	await expect(chat.getByText(
		"Error: Place its investigation card in the document before requiring it for Build",
		{ exact: true },
	)).toBeVisible();
	await expect(page.getByRole("button", { name: "Build plan", exact: true })).toBeEnabled();
});
