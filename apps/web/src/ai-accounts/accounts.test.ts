import { describe, expect, test } from "bun:test";

import { accountRows, withCheck, withCredential, withoutCredential } from "./accounts";

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

function copilot(summary: AiCredentialSummary, checking = false) {
	return accountRows([summary], NOW, checking).signIns[0]!;
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

	test("without a seat it says so in neutral words and offers a token and Get Copilot", () => {
		expect(copilot({ ...SIGN_IN, copilotAccess: "none" })).toEqual({
			provider: "github-copilot",
			name: "GitHub Copilot",
			badge: { tone: "neutral", label: "No Copilot access" },
			lines: ["Your GitHub account has no Copilot subscription."],
			getCopilot: true,
			actions: ["use-token"],
		});
	});

	test("an unfinished check says the page checks again when it opens, never that there is no subscription, and offers a token", () => {
		for (let access of ["unknown", undefined] as const) {
			let row = copilot({ ...SIGN_IN, copilotAccess: access });
			expect(row.badge).toEqual({ tone: "neutral", label: "Not checked" });
			expect(row.lines).toEqual([
				"Your GitHub sign-in",
				"Chopin couldn't check for Copilot access through your GitHub sign-in. It checks again when you open this page.",
			]);
			expect(row.getCopilot).toBe(false);
			expect(row.actions).toEqual(["use-token"]);
			expect(JSON.stringify(row)).not.toContain("subscription");
		}
	});

	test("while the page checks, a row with no answer says it is checking", () => {
		for (let access of ["unknown", undefined] as const) {
			expect(copilot({ ...SIGN_IN, copilotAccess: access }, true)).toEqual({
				provider: "github-copilot",
				name: "GitHub Copilot",
				badge: { tone: "neutral", label: "Checking…" },
				lines: ["Your GitHub sign-in"],
				getCopilot: false,
				actions: [],
			});
		}
	});

	test("while the page checks, an earlier answer stands", () => {
		for (let access of ["access", "none"] as const) {
			let summary: AiCredentialSummary = { ...SIGN_IN, copilotAccess: access };
			expect(copilot(summary, true)).toEqual(copilot(summary));
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

	test("an unfinished check keeps the token's ending and its way back, and says so", () => {
		let row = copilot({ ...token, copilotAccess: "unknown" });
		expect(row.badge).toEqual({ tone: "neutral", label: "Not checked" });
		expect(row.lines).toEqual([
			"Token ending f00d",
			"Chopin couldn't check this token for Copilot access. It checks again when you open this page.",
		]);
		expect(row.actions).toEqual(["replace", "use-sign-in"]);
		expect(copilot({ ...token, copilotAccess: "unknown" }, true).lines).toEqual([
			"Token ending f00d",
		]);
	});

	test("without a seat it offers no check, only another token or the sign-in", () => {
		expect(copilot({ ...token, copilotAccess: "none" }).actions).toEqual([
			"replace",
			"use-sign-in",
		]);
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

describe("the check as the page opens", () => {
	let token: AiCredentialSummary = {
		provider: "github-copilot",
		kind: "api-key",
		updatedAt: "2026-11-19T11:00:00.000Z",
		suffix: "f00d",
		copilotAccess: "access",
	};

	test("its answer replaces the list's for the credential it checked", () => {
		let checked = withCheck([OPENAI, { ...SIGN_IN, copilotAccess: "none" }], SIGN_IN);
		expect(checked.find(credential => credential.provider === "github-copilot"))
			.toEqual(SIGN_IN);
		expect(withCheck([token, OPENAI], { ...token, copilotAccess: "none" })[1])
			.toEqual({ ...token, copilotAccess: "none" });
	});

	test("a credential connected or switched since keeps its own answer", () => {
		let replaced = { ...token, updatedAt: "2026-11-19T11:30:00.000Z", suffix: "beef" };
		expect(withCheck([replaced], { ...token, copilotAccess: "none" })).toEqual([replaced]);
		expect(withCheck([SIGN_IN], { ...token, copilotAccess: "none" })).toEqual([SIGN_IN]);
		expect(withCheck([token], { ...SIGN_IN, copilotAccess: "none" })).toEqual([token]);
	});
});

test("a change replaces only its provider's summary", () => {
	let replaced = withCredential([SIGN_IN, OPENAI], { ...OPENAI, suffix: "9zz9" });
	expect(replaced.map(credential => credential.suffix)).toEqual([undefined, "9zz9"]);
	expect(withoutCredential(replaced, "openai")).toEqual([SIGN_IN]);
});

describe("ChatGPT and Claude sign-ins", () => {
	function signIns(credentials: AiCredentialSummary[] = []) {
		let [, chatgpt, claude] = accountRows(credentials, NOW).signIns;
		return { chatgpt: chatgpt!, claude: claude! };
	}

	const CHATGPT: AiCredentialSummary = {
		provider: "chatgpt",
		kind: "subscription",
		updatedAt: "2026-11-18T09:00:00.000Z",
		lastUsedAt: "2026-11-19T11:58:00.000Z",
	};

	test("sit under Copilot, each offering its own sign-in until one is connected", () => {
		let { chatgpt, claude } = signIns();
		expect(chatgpt).toEqual({
			provider: "chatgpt",
			name: "ChatGPT",
			lines: ["Use OpenAI models with your ChatGPT plan."],
			getCopilot: false,
			actions: ["sign-in"],
		});
		expect(claude.name).toBe("Claude");
		expect(claude.actions).toEqual(["sign-in"]);
		expect(accountRows([], NOW).keys.map(row => row.provider)).toEqual(["openai", "anthropic"]);
	});

	test("a connected sign-in says whose it is and when it was last used, and can be disconnected", () => {
		expect(signIns([CHATGPT]).chatgpt).toEqual({
			provider: "chatgpt",
			name: "ChatGPT",
			badge: { tone: "success", label: "Connected" },
			lines: ["Your ChatGPT sign-in", "Last used 2m ago"],
			getCopilot: false,
			actions: ["disconnect"],
		});
	});

	test("a sign-in its provider ended, or Chopin can't read, never reads as connected", () => {
		let ended = signIns([{ ...CHATGPT, provider: "claude", rejectedAt: NOW_ISO }]).claude;
		expect(ended.badge).toEqual({ tone: "warning", label: "Needs reconnecting" });
		expect(ended.lines).toEqual(["Claude ended this sign-in. Sign in again to keep using it."]);
		expect(ended.actions).toEqual(["sign-in", "disconnect"]);
		let unreadable = signIns([{ ...CHATGPT, unusable: true }]).chatgpt;
		expect(unreadable.badge?.label).toBe("Needs reconnecting");
		expect(unreadable.lines).toEqual([
			"Chopin can't read this sign-in anymore. Sign in again to keep using it.",
		]);
	});

	test("a sign-in Chopin couldn't renew just now says the check couldn't finish", () => {
		let row = signIns([{ ...CHATGPT, unchecked: true }]).chatgpt;
		expect(row.badge).toEqual({ tone: "neutral", label: "Not checked" });
		expect(row.lines).toEqual([
			"Your ChatGPT sign-in",
			"Chopin couldn't finish checking this sign-in.",
		]);
		expect(row.actions).toEqual(["disconnect"]);
	});
});

const NOW_ISO = new Date(NOW).toISOString();
