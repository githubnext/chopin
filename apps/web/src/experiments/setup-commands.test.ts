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

test("connect names this server and installs the service in one step", () => {
	expect(connectCommand("https://chopin.example", "sh")).toBe(
		"CHOPIN_URL=https://chopin.example chopin connect . --install-service -- copilot --acp --allow-all",
	);
	expect(connectCommand("https://chopin.example", "powershell")).toBe(
		'$env:CHOPIN_URL="https://chopin.example"; chopin connect . --install-service -- copilot --acp --allow-all',
	);
});
