import { describe, expect, test } from "bun:test";

import { accountRows, withCredential, withoutCredential } from "./accounts";

import type { AiCredentialSummary } from "@chopin/protocol/ai-credentials";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");

const SIGN_IN: AiCredentialSummary = {
	provider: "github-copilot",
	kind: "github-sign-in",
	copilotAccess: "access",
};

const OPENAI: AiCredentialSummary = {
	provider: "openai",
	kind: "api-key",
	updatedAt: "2026-11-18T09:00:00.000Z",
	suffix: "7Qxa",
	lastUsedAt: "2026-11-19T11:58:00.000Z",
};

function copilot(summary: AiCredentialSummary) {
	return accountRows([summary], NOW).signIns[0]!;
}

function key(summary?: AiCredentialSummary) {
	return accountRows(summary ? [summary] : [], NOW).keys[0]!;
}

describe("GitHub Copilot through the sign-in", () => {
	test("with a seat it is connected and asks nothing of the person", () => {
		expect(copilot(SIGN_IN)).toEqual({
			provider: "github-copilot",
			name: "GitHub Copilot",
			badge: { tone: "success", label: "Connected" },
			lines: ["Your GitHub sign-in"],
			getCopilot: false,
			actions: [],
		});
	});

	test("without a seat it says so in neutral words and offers a token, Get Copilot and Check again", () => {
		expect(copilot({ ...SIGN_IN, copilotAccess: "none" })).toEqual({
			provider: "github-copilot",
			name: "GitHub Copilot",
			badge: { tone: "neutral", label: "No Copilot access" },
			lines: ["Your GitHub account has no Copilot subscription."],
			getCopilot: true,
			actions: ["use-token", "check-again"],
		});
	});

	test("an unfinished check never says the account lacks a subscription", () => {
		for (let access of ["unknown", undefined] as const) {
			let row = copilot({ ...SIGN_IN, copilotAccess: access });
			expect(row.badge).toEqual({ tone: "neutral", label: "Not checked" });
			expect(row.lines).toEqual([
				"Your GitHub sign-in",
				"Chopin couldn't finish checking for Copilot access.",
			]);
			expect(row.getCopilot).toBe(false);
			expect(row.actions).toEqual(["check-again"]);
			expect(JSON.stringify(row)).not.toContain("subscription");
		}
	});
});

describe("GitHub Copilot through a token", () => {
	let token: AiCredentialSummary = {
		provider: "github-copilot",
		kind: "api-key",
		suffix: "f00d",
		copilotAccess: "access",
	};

	test("shows the token's ending, its last use, and a way back to the sign-in", () => {
		let row = copilot(token);
		expect(row.lines).toEqual(["Token ending f00d", "Never used"]);
		expect(row.actions).toEqual(["replace", "use-sign-in"]);
	});

	test("an unreadable token needs reconnecting", () => {
		let row = copilot({ ...token, unusable: true });
		expect(row.badge).toEqual({ tone: "warning", label: "Needs reconnecting" });
		expect(row.actions).toEqual(["replace", "use-sign-in"]);
	});
});

describe("API keys", () => {
	test("a missing key offers Add key and nothing else", () => {
		expect(key()).toEqual({
			provider: "openai",
			name: "OpenAI",
			lines: ["Use OpenAI models with your own key."],
			getCopilot: false,
			actions: ["add-key"],
		});
		expect(accountRows([], NOW).keys.map(row => row.name)).toEqual(["OpenAI", "Anthropic"]);
	});

	test("a connected key shows its ending and last use, each on its own line", () => {
		expect(key(OPENAI)).toEqual({
			provider: "openai",
			name: "OpenAI",
			badge: { tone: "success", label: "Connected" },
			lines: ["Key ending 7Qxa", "Last used 2m ago"],
			getCopilot: false,
			actions: ["replace", "remove"],
		});
		expect(key({ ...OPENAI, lastUsedAt: undefined }).lines).toEqual([
			"Key ending 7Qxa",
			"Never used",
		]);
	});

	test("an unusable key says it needs reconnecting", () => {
		let row = key({ ...OPENAI, unusable: true });
		expect(row.badge).toEqual({ tone: "warning", label: "Needs reconnecting" });
		expect(row.lines).toEqual([
			"Key ending 7Qxa",
			"Chopin can't read this key anymore. Replace it to keep using it.",
		]);
		expect(row.actions).toEqual(["replace", "remove"]);
	});

	test("a key its provider refused says it needs reconnecting, with the provider's name", () => {
		let row = key({ ...OPENAI, rejectedAt: "2026-11-19T10:00:00.000Z" });
		expect(row.badge).toEqual({ tone: "warning", label: "Needs reconnecting" });
		expect(row.lines).toEqual([
			"Key ending 7Qxa",
			"OpenAI no longer accepts this key. Replace it to keep using it.",
		]);
		expect(row.actions).toEqual(["replace", "remove"]);
	});
});

test("a change replaces only its provider's summary", () => {
	let replaced = withCredential([SIGN_IN, OPENAI], { ...OPENAI, suffix: "9zz9" });
	expect(replaced.map(credential => credential.suffix)).toEqual([undefined, "9zz9"]);
	expect(withoutCredential(replaced, "openai")).toEqual([SIGN_IN]);
});
