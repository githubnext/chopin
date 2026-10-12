import { expect, test } from "bun:test";
import { connectorCommand } from "./local-agent-note";

test("the connector command keeps the project folder's .env and bunfig.toml out of Bun", () => {
	expect(connectorCommand("https://chopin.example")).toBe(
		"mkdir -p ~/.chopin && curl -fsSL https://chopin.example/connector.js -o ~/.chopin/connector.js"
			+ " && CHOPIN_URL=https://chopin.example bun --no-env-file --config=/dev/null"
			+ " ~/.chopin/connector.js connect . -- copilot --acp --allow-all",
	);
});
