import { describe, expect, test } from "bun:test";

import {
	CHAT_COMMANDS,
	commandBrief,
	commandKeyAction,
	commandText,
	commandTrigger,
	draftCommand,
	filterCommands,
} from "./commands";

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
