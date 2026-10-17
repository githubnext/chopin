import { expect, test } from "bun:test";

import { line } from "./planner-job-support";

import type { ConversationPlan } from "@chopin/protocol";

let heading = { kind: "heading", target: "document" } as ConversationPlan.Job;

test("a heading job that kept a person's title announces only its goal", () => {
	let output = JSON.stringify({ title: "Login resume", goal: "Goal: Resume.", titleKept: true });
	expect(line({} as never, heading, output)).toEqual(["Chopin drafted the goal", "document"]);
	expect(line({} as never, heading, JSON.stringify({ title: "Login", goal: "Goal: Resume." })))
		.toEqual(["Chopin drafted the title and goal", "document"]);
});
