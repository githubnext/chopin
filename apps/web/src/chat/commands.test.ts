import { describe, expect, test } from "bun:test";

import {
	CHAT_COMMANDS,
	commandBrief,
	commandKeyAction,
	commandList,
	commandText,
	commandTrigger,
	draftCommand,
	filterCommands,
} from "./commands";

describe("the commands the agent reports", () => {
	let reported = [
		{ name: "review", kind: "prompt", description: "Review the diff" },
		{ name: "skill:release-notes", kind: "skill", description: "Draft release notes" },
		{ name: "ship", kind: "workflow" },
		{ name: "review", kind: "prompt", description: "Again" },
		{ name: "deploy", kind: "Pipeline" },
		{ name: "skill:notes", kind: "skill" },
	];

	test("follow Chat's own, grouped by kind in the order each first appears and listed as reported", () => {
		let list = commandList(CHAT_COMMANDS, reported);
		expect(list.map(command => [command.group, command.name])).toEqual([
			["Built in", "research"],
			["Prompt templates", "review"],
			["Prompt templates", "review"],
			["Skills", "skill:release-notes"],
			["Skills", "skill:notes"],
			["Workflows", "ship"],
			["Pipeline", "deploy"],
		]);
		// A repeated entry is its own row, with its own description and its own key.
		let repeated = list.filter(command => command.name === "review");
		expect(repeated.map(command => command.description)).toEqual(["Review the diff", "Again"]);
		expect(new Set(list.map(command => command.id)).size).toBe(list.length);
		expect(list.find(command => command.name === "ship")).not.toHaveProperty("description");
		expect(list.find(command => command.name === "ship")).toMatchObject({
			source: "agent",
			commandKind: "workflow",
		});
	});

	test("are Chat's own alone for an agent that reports none", () => {
		expect(commandList(CHAT_COMMANDS, undefined)).toEqual([...CHAT_COMMANDS]);
		expect(commandList(CHAT_COMMANDS, [])).toEqual([...CHAT_COMMANDS]);
		expect(commandList([], undefined)).toEqual([]);
	});

	test("filter by the name or by what follows a skill's prefix, whatever the case", () => {
		let list = commandList(CHAT_COMMANDS, reported);
		expect(filterCommands(list, "rev").map(command => command.name)).toEqual(["review", "review"]);
		expect(filterCommands(list, "release").map(command => command.name)).toEqual([
			"skill:release-notes",
		]);
		expect(filterCommands(list, "skill:n").map(command => command.name)).toEqual(["skill:notes"]);
		expect(filterCommands(list, "SH").map(command => command.name)).toEqual(["ship"]);
		expect(filterCommands(list, "zzz")).toEqual([]);
	});

	test("open the list for a name with a colon, a dot or a hyphen, and not for a path", () => {
		expect(commandTrigger("/skill:rel", 10)).toEqual({ query: "skill:rel", end: 10 });
		expect(commandTrigger("/release-notes.v2", 17)?.query).toBe("release-notes.v2");
		expect(commandTrigger("/usr/bin", 8)).toBeUndefined();
	});

	test("are run as the text of their name and a space", () => {
		let [review] = commandList([], reported);
		expect(commandText(review!)).toBe("/review ");
	});
});

describe("chat commands", () => {
	test("open only while the draft is a single /query at the caret", () => {
		expect(commandTrigger("/", 1)).toEqual({ query: "", end: 1 });
		expect(commandTrigger("/res", 4)).toEqual({ query: "res", end: 4 });
		expect(commandTrigger("/res ", 4)).toEqual({ query: "res", end: 4 });
		expect(commandTrigger("a /res", 6)).toBeUndefined();
		expect(commandTrigger("/research ", 10)).toBeUndefined();
		expect(commandTrigger("/usr/bin", 8)).toBeUndefined();
		expect(commandTrigger("/res", 2)).toBeUndefined();
		expect(commandTrigger("/res", 0, 4)).toBeUndefined();
	});

	test("filter by keyword prefix", () => {
		expect(filterCommands(CHAT_COMMANDS, "").map(command => command.id)).toEqual(["research"]);
		expect(filterCommands(CHAT_COMMANDS, "RES").map(command => command.id)).toEqual(["research"]);
		expect(filterCommands(CHAT_COMMANDS, "web").map(command => command.id)).toEqual(["research"]);
		expect(filterCommands(CHAT_COMMANDS, "code")).toEqual([]);
	});

	test("recognise a research command so it is never posted", () => {
		expect(draftCommand("/research")).toBe("research");
		expect(draftCommand("  /Research what changed?")).toBe("research");
		expect(draftCommand("/researcher")).toBeUndefined();
		expect(draftCommand("please /research this")).toBeUndefined();
		expect(draftCommand("@chopin /research pricing")).toBe("research");
		expect(draftCommand("@chopin please /research")).toBeUndefined();
		expect(commandText(CHAT_COMMANDS[0]!)).toBe("/research ");
	});

	test("the brief is what follows the command, references included as text", () => {
		expect(commandBrief("/research")).toBe("");
		expect(commandBrief("  /research   what changed in #Pricing?  ")).toBe(
			"what changed in #Pricing?",
		);
		expect(commandBrief("@Chopin /research pricing\nand limits")).toBe("pricing\nand limits");
	});

	test("Tab and Enter select; arrows move", () => {
		expect(commandKeyAction({ key: "Tab" }, true)).toBe("select");
		expect(commandKeyAction({ key: "Tab", shiftKey: true }, true)).toBeUndefined();
		expect(commandKeyAction({ key: "Enter" }, true)).toBe("select");
		expect(commandKeyAction({ key: "ArrowDown" }, true)).toBe("next");
		expect(commandKeyAction({ key: "Enter", isComposing: true }, true)).toBeUndefined();
	});
});
