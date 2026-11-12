/**
 * What the agent is told about names, and what it is shown of them.
 *
 * Chat draws a person by their GitHub handle exactly as GitHub has it and the agent as `chopin`.
 * Every model whose words a person reads is told to write them the same way, and nothing on the
 * way to a prompt changes a handle's case, so the model never sees a name it should not copy.
 */

import { describe, expect, it } from "bun:test";

import { address } from "../comments/prompt";
import { compose } from "../chat/address";
import { READER_INSTRUCTIONS } from "../chat/reaction-instructions";
import { reactionInstruction } from "../chat/reaction-reply";
import { headingPrompt } from "../conversation-plan/job-prompts";
import { prosePrompt } from "../conversation-plan/prose-job";
import { NAMES_AS_WRITTEN } from "./identity";
import { plannerInstructions, PROMPT } from "./planner";

import type { Chat } from "@chopin/protocol";
import type { Record as Thread } from "../comments/service";

const HANDLES = ["mona_acme", "Hubot-Bot", "lavaman131"];

describe("the rule every writer is given", () => {
	it("names the agent chopin and keeps a handle as written, Chopin being only the product", () => {
		expect(NAMES_AS_WRITTEN).toContain("In Chat you appear as chopin, all lower case");
		expect(NAMES_AS_WRITTEN).toContain("@mona_acme or @Hubot-Bot");
		expect(NAMES_AS_WRITTEN).toContain("even at the start of a sentence");
		expect(NAMES_AS_WRITTEN).toContain("Chopin, with a capital, is the product's name");
	});

	it("is in the Planner's instructions wherever its session runs", () => {
		expect(PROMPT).toContain(NAMES_AS_WRITTEN);
		let places = [
			plannerInstructions("octo-org/score"),
			plannerInstructions("octo-org/score", undefined, undefined, true),
			plannerInstructions("octo-org/score", undefined, { remote: true }),
			plannerInstructions("octo-org/score", undefined, { cwd: "/tmp/scratch", checkout: false }),
		];
		for (let instructions of places) expect(instructions).toContain(NAMES_AS_WRITTEN);
	});

	it("is in a reaction reader's instructions, which name the agent chopin", () => {
		expect(READER_INSTRUCTIONS).toContain(NAMES_AS_WRITTEN);
		expect(READER_INSTRUCTIONS.startsWith("You are chopin,")).toBe(true);
	});
});

describe("the prompts a writer reads", () => {
	it("give each speaker in Chat by their handle exactly as written", () => {
		let said = HANDLES.map(handle => ({ handle, text: "the rollout can wait" }));
		let prompt = compose(said, "mona_acme", "@chopin what does a review need?");
		for (let handle of HANDLES) expect(prompt).toContain(`@${handle}: the rollout can wait`);
		expect(prompt).toContain("@mona_acme: what does a review need?");
	});

	it("give a comment's notes by handle, and the agent's own as chopin", () => {
		let thread = {
			id: "thread-1",
			notes: [
				{ id: "n1", author: "member", handle: "Hubot-Bot", text: "Shorter?", ts: 1, to: "planner" },
				{ id: "n2", author: "planner", text: "Done.", ts: 2 },
			],
		} as unknown as Thread;
		let prompt = address(thread, "the passage");
		expect(prompt).toContain("@Hubot-Bot → chopin: Shorter?");
		expect(prompt).toContain("@chopin: Done.");
		expect(prompt).not.toContain("Chopin");
	});

	it("give the people behind a reaction, a heading and a decision as written", () => {
		let entry = { id: "a1", author: { kind: "agent" }, text: "Three phases.", ts: 1 };
		expect(reactionInstruction(entry as Chat.Entry, "❓", "Hubot-Bot", "confused"))
			.toContain(JSON.stringify("Hubot-Bot"));

		let transcript = HANDLES.map((handle, index) => ({
			id: `m${index}`,
			author: { kind: "member", handle },
			text: "Plan the pilot.",
			ts: index,
		})) as Chat.Entry[];
		let heading = headingPrompt({ transcript, outline: "# Pilot" });
		for (let handle of HANDLES) expect(heading).toContain(`- @${handle}: Plan the pilot.`);

		let prose = prosePrompt({
			id: "card",
			question: "Which team goes first?",
			chosen: ["Docs"],
			owner: "mona_acme",
			involved: ["mona_acme", "Hubot-Bot"],
			reasons: [],
		});
		expect(prose).toContain("Saved by: mona_acme; discussed with Hubot-Bot");
	});
});
