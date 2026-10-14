import { expect, test } from "bun:test";
import { connectCommand, installCommand, pairCommand } from "./setup-commands";

test("install uses the released installer for each shell, breaking before the pipe where the shell can", () => {
	expect(installCommand("sh")).toBe(
		[
			"curl -fsSL https://github.com/githubnext/chopin/releases/latest/download/install.sh \\",
			"  | sh",
		].join("\n"),
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

test("pairing again keeps the machine's name, quoted only when the shell needs it", () => {
	expect(pairCommand("build-box.local")).toBe("chopin pair --label build-box.local");
	expect(pairCommand("Mia’s MacBook")).toBe('chopin pair --label "Mia’s MacBook"');
	// A name either shell would expand inside quotes falls back to the hostname default.
	expect(pairCommand('say "$HOME"')).toBe("chopin pair");
	expect(pairCommand("")).toBe("chopin pair");
});
