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
