import { chatInput } from "./chat-input";
import { content, expect, ready, test, written } from "./room";
import type { Chat } from "../packages/protocol/index";

const ANSWER = "Keep offline access and retain the existing keyboard shortcuts.";
const CONSTRAINT = "What constraints must the first version preserve?";
const ROLLOUT = "How should the first version reach the team?";

test("captured decisions outlive the turn and each saved answer updates their shared passage", async ({ join, page, room, seed }) => {
	await seed("# Planner decisions\n\nExisting team notes remain unchanged.\n");
	let states: Chat.State[] = [];
	let messages: Chat.Entry[] = [];
	await page.routeWebSocket("**/ws?**", route => {
		let server = route.connectToServer();
		route.onMessage(message => server.send(message));
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Chat.Outgoing;
				if (frame.kind === "chat:state") states.push(frame);
				if (frame.kind === "chat:message" && frame.entry.author.kind === "agent") {
					messages.push(frame.entry);
				}
			}
			route.send(message);
		});
	});
	let opened = await join("ana");
	let chat = opened.getByRole("complementary", { name: "Chat" });
	await chatInput(chat).fill("@chopin ANCHORED-DECISIONS draft the first version.");
	await chat.getByRole("button", { name: "Send message", exact: true }).click();
	await expect.poll(() =>
		messages.some(entry => entry.text === "I drafted the passage and opened two decisions.")
	)
		.toBe(true);
	await expect.poll(() => states.at(-1)?.busy).toBe(false);

	let document = content(opened);
	await expect(document.getByRole("group", { name: "2 decisions", exact: true })).toHaveCount(1);
	let writtenCard = document.locator("article[data-plan-sidecar-questionnaire]")
		.filter({ has: opened.getByRole("heading", { name: CONSTRAINT, exact: true }) });
	await expect(writtenCard.getByRole("textbox", { name: "Answer", exact: true })).toHaveValue("");
	await written(
		opened,
		room,
		/The first version remains provisional\.[\s\S]*<Questionnaire[\s\S]*response="text"[\s\S]*<Questionnaire/,
	);
	expect(messages.every(entry => !/[?]|tell me|let me know/i.test(entry.text))).toBe(true);
	await test.info().attach("anchored-decisions-open", {
		body: await opened.screenshot({ animations: "disabled" }),
		contentType: "image/png",
	});

	await writtenCard.getByRole("textbox", { name: "Answer", exact: true }).fill(ANSWER);
	await writtenCard.getByRole("button", { name: "Save", exact: true }).click();
	await expect(document.getByText(`Constraints: ${ANSWER}`, { exact: true })).toBeVisible();
	await written(opened, room, `Constraints: ${ANSWER}`);
	await expect(document.getByText("Existing team notes remain unchanged.", { exact: true }))
		.toBeVisible();

	let choiceCard = document.locator("article[data-plan-sidecar-questionnaire]")
		.filter({ has: opened.getByRole("heading", { name: ROLLOUT, exact: true }) });
	await expect(choiceCard).toBeVisible();
	await choiceCard.getByText("Small pilot", { exact: true }).click();
	await expect(choiceCard.getByRole("radio", { name: /^Small pilot/ })).toBeChecked();
	await choiceCard.getByRole("button", { name: "Save", exact: true }).click();
	let combined = `Constraints: ${ANSWER} Rollout: Small pilot.`;
	await expect(document.getByText(combined, { exact: true })).toBeVisible();
	await written(opened, room, combined);
	await test.info().attach("anchored-decisions-saved", {
		body: await opened.screenshot({ animations: "disabled" }),
		contentType: "image/png",
	});
	await opened.reload();
	await ready(opened);
	await expect(content(opened).getByText(combined, { exact: true })).toBeVisible();
	await expect(content(opened).getByText("Existing team notes remain unchanged.", { exact: true }))
		.toBeVisible();
});
