import { expect, test } from "bun:test";
import { connectorCommand, localAgentNoteText } from "./local-agent-note";

test("the connector command keeps the project folder's .env and bunfig.toml out of Bun", () => {
	expect(connectorCommand("https://chopin.example")).toBe(
		"mkdir -p ~/.chopin && curl -fsSL https://chopin.example/connector.js -o ~/.chopin/connector.js"
			+ " && CHOPIN_URL=https://chopin.example bun --no-env-file --config=/dev/null"
			+ " ~/.chopin/connector.js connect --agent copilot",
	);
});

test("the local agent note names a button only when there is one to press", () => {
	expect(localAgentNoteText("Retry")).toBe(
		"Your local agent isn’t connected. Run this in a terminal, then press Retry again.",
	);
	expect(localAgentNoteText()).toBe(
		"Your local agent isn’t connected. Run this in a terminal to connect it.",
	);
});
