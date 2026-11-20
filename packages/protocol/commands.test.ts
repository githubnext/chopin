import { describe, expect, it } from "bun:test";

import { commandGroupLabel, commandPrompt, offeredCommand } from "./commands";

describe("the commands a document's agent offers", () => {
	it("names each known kind's group and any other kind as the agent wrote it", () => {
		expect(commandGroupLabel("skill")).toBe("Skills");
		expect(commandGroupLabel("prompt")).toBe("Prompt templates");
		expect(commandGroupLabel("workflow")).toBe("workflow");
		expect(commandGroupLabel("Pipeline")).toBe("Pipeline");
	});

	it("finds a command by its exact name and kind, the first of a repeated entry", () => {
		let commands = [
			{ name: "Review", kind: "prompt", description: "first" },
			{ name: "Review", kind: "skill" },
			{ name: "Review", kind: "prompt", description: "second" },
		];
		expect(offeredCommand(commands, "Review", "prompt")?.description).toBe("first");
		expect(offeredCommand(commands, "Review", "skill")).toBe(commands[1]);
		expect(offeredCommand(commands, "review", "prompt")).toBeUndefined();
		expect(offeredCommand(commands, "Review", "workflow")).toBeUndefined();
		expect(offeredCommand(undefined, "Review", "prompt")).toBeUndefined();
	});

	it("runs a command of any kind as Atomic's own /name args", () => {
		expect(commandPrompt({ name: "skill:notes", kind: "skill" }, "for today")).toBe(
			"/skill:notes for today",
		);
		expect(commandPrompt({ name: "review", kind: "prompt" }, "")).toBe("/review");
		expect(commandPrompt({ name: "x", kind: "anything" }, "a  b")).toBe("/x a  b");
		expect(commandPrompt({ name: "ship", kind: "workflow" }, "v2")).toBe("/ship v2");
	});
});
