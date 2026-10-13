import { expect, test } from "bun:test";
import { connectCommand, installCommand } from "./setup-commands";

test("install uses the released installer for each shell", () => {
	expect(installCommand("sh")).toBe(
		"curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh | sh",
	);
	expect(installCommand("powershell")).toBe(
		"irm https://github.com/githubnext/chopin/releases/latest/download/install.ps1 | iex",
	);
});

test("connect breaks between whole arguments, with each shell's own line continuation", () => {
	expect(connectCommand("https://chopin.example", "sh")).toBe(
		[
			"CHOPIN_URL=https://chopin.example chopin connect . \\",
			"  --install-service \\",
			"  -- copilot --acp --allow-all",
		].join("\n"),
	);
	expect(connectCommand("https://chopin.example", "powershell")).toBe(
		[
			'$env:CHOPIN_URL="https://chopin.example"',
			"chopin connect . `",
			"  --install-service `",
			"  -- copilot --acp --allow-all",
		].join("\n"),
	);
});
