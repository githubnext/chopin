import { describe, expect, test } from "bun:test";

import { accountRows, withCheck, withCredential, withoutCredential } from "./accounts";

import type { AiCredentialSummary } from "@chopin/protocol/ai-credentials";

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
	return accountRows([summary], checking).signIns[0]!;
}

function key(summary?: AiCredentialSummary) {
	return accountRows(summary ? [summary] : []).keys[0]!;
}

describe("GitHub Copilot through the sign-in", () => {
	test("with a seat it is connected, and still takes a token instead", () => {
		expect(copilot(SIGN_IN)).toEqual({
			provider: "github-copilot",
			name: "GitHub Copilot",
			badge: { tone: "success", label: "Connected" },
			lines: ["Your GitHub sign-in"],
			getCopilot: false,
			more: ["use-token"],
		});
	});

	test("without a seat it says so in neutral words and offers a token and Get Copilot", () => {
		expect(copilot({ ...SIGN_IN, copilotAccess: "none" })).toEqual({
			provider: "github-copilot",
			name: "GitHub Copilot",
			badge: { tone: "neutral", label: "No Copilot access" },
			lines: ["Your GitHub account has no Copilot subscription."],
			getCopilot: true,
			more: ["use-token"],
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
			expect(row.action).toBeUndefined();
			expect(row.more).toEqual(["use-token"]);
			expect(JSON.stringify(row)).not.toContain("subscription");
		}
	});

	test("while the page checks, a row with no answer says it is checking and takes a token", () => {
		for (let access of ["unknown", undefined] as const) {
			expect(copilot({ ...SIGN_IN, copilotAccess: access }, true)).toEqual({
				provider: "github-copilot",
				name: "GitHub Copilot",
				badge: { tone: "neutral", label: "Checking…" },
				lines: ["Your GitHub sign-in"],
				getCopilot: false,
				more: ["use-token"],
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

	test("shows the token's ending, with replacing it and the way back to the sign-in in its menu", () => {
		let row = copilot(token);
		expect(row.lines).toEqual(["Token ending f00d"]);
		expect(copilot({ ...token, lastUsedAt: "2026-11-19T11:58:00.000Z" }).lines).toEqual([
			"Token ending f00d",
		]);
		expect(row.action).toBeUndefined();
		expect(row.more).toEqual(["replace", "use-sign-in"]);
	});

	test("an unfinished check keeps the token's ending and its way back, and says so", () => {
		let row = copilot({ ...token, copilotAccess: "unknown" });
		expect(row.badge).toEqual({ tone: "neutral", label: "Not checked" });
		expect(row.lines).toEqual([
			"Token ending f00d",
			"Chopin couldn't check this token for Copilot access. It checks again when you open this page.",
		]);
		expect(row.more).toEqual(["replace", "use-sign-in"]);
		expect(copilot({ ...token, copilotAccess: "unknown" }, true).lines).toEqual([
			"Token ending f00d",
		]);
	});

	test("without a seat it offers no check, only another token or the sign-in", () => {
		let row = copilot({ ...token, copilotAccess: "none" });
		expect(row.action).toBeUndefined();
		expect(row.more).toEqual(["replace", "use-sign-in"]);
	});

	test("an unreadable token needs reconnecting, and asks to be replaced on the row", () => {
		let row = copilot({ ...token, unusable: true });
		expect(row.badge).toEqual({ tone: "warning", label: "Needs reconnecting" });
		expect(row.action).toBe("replace");
		expect(row.more).toEqual(["use-sign-in"]);
	});
});

describe("every state of the GitHub Copilot row", () => {
	const CREDENTIALS = {
		"sign-in": SIGN_IN,
		token: { provider: "github-copilot", kind: "api-key", suffix: "f00d" },
		"refused token": {
			provider: "github-copilot",
			kind: "api-key",
			suffix: "f00d",
			rejectedAt: "2026-11-19T10:00:00.000Z",
		},
		"unreadable token": {
			provider: "github-copilot",
			kind: "api-key",
			suffix: "f00d",
			unusable: true,
		},
	} satisfies Record<string, AiCredentialSummary>;
	const SWITCHES = new Set(["use-token", "use-sign-in", "replace"]);

	let states = Object.entries(CREDENTIALS).flatMap(([credential, base]) =>
		(["access", "none", "unknown", undefined] as const).flatMap(copilotAccess =>
			[false, true].map(checking => ({
				name: `${credential}, access ${copilotAccess}, ${checking ? "" : "not "}checking`,
				signIn: credential === "sign-in",
				saidNone: copilotAccess === "none",
				usable: copilotAccess === "access" && (credential === "sign-in" || credential === "token"),
				row: copilot({ ...base, copilotAccess }, checking),
			}))
		)
	);

	test("there are 32 of them", () => {
		expect(states).toHaveLength(32);
	});

	for (let { name, signIn, saidNone, usable, row } of states) {
		test(name, () => {
			let actions = [...(row.action ? [row.action] : []), ...row.more];
			if (signIn) {
				expect(actions).toContain("use-token");
			} else {
				expect(actions).toContain("replace");
				expect(actions).toContain("use-sign-in");
			}
			expect(actions.includes("use-token") && actions.includes("use-sign-in")).toBe(false);
			expect(actions.some(action => SWITCHES.has(action))).toBe(true);
			// Only a token that needs reconnecting asks for an action on the row itself.
			expect(row.action).toBe(row.badge?.label === "Needs reconnecting" ? "replace" : undefined);
			let claimsNone = row.badge?.label === "No Copilot access" || row.getCopilot
				|| row.lines.some(line => line.includes("subscription"));
			if (claimsNone) expect(saidNone).toBe(true);
			expect(row.badge?.label === "Connected").toBe(usable);
		});
	}
});

describe("API keys", () => {
	test("a missing key offers Add key and nothing else", () => {
		expect(key()).toEqual({
			provider: "openai",
			name: "OpenAI",
			lines: ["Use OpenAI models with your own key."],
			getCopilot: false,
			action: "add-key",
			more: [],
		});
		expect(accountRows([]).keys.map(row => row.name)).toEqual(["OpenAI", "Anthropic"]);
	});

	test("a connected key shows its ending, and nothing of when it was used", () => {
		expect(key(OPENAI)).toEqual({
			provider: "openai",
			name: "OpenAI",
			badge: { tone: "success", label: "Connected" },
			lines: ["Key ending 7Qxa"],
			getCopilot: false,
			more: ["replace", "remove"],
		});
		expect(key({ ...OPENAI, lastUsedAt: undefined }).lines).toEqual(["Key ending 7Qxa"]);
	});

	test("an unusable key says it needs reconnecting", () => {
		let row = key({ ...OPENAI, unusable: true });
		expect(row.badge).toEqual({ tone: "warning", label: "Needs reconnecting" });
		expect(row.lines).toEqual([
			"Key ending 7Qxa",
			"Chopin can't read this key anymore. Replace it to keep using it.",
		]);
		expect(row.action).toBe("replace");
		expect(row.more).toEqual(["remove"]);
	});

	test("a key its provider refused says it needs reconnecting, with the provider's name", () => {
		let row = key({ ...OPENAI, rejectedAt: "2026-11-19T10:00:00.000Z" });
		expect(row.badge).toEqual({ tone: "warning", label: "Needs reconnecting" });
		expect(row.lines).toEqual([
			"Key ending 7Qxa",
			"OpenAI no longer accepts this key. Replace it to keep using it.",
		]);
		expect(row.action).toBe("replace");
		expect(row.more).toEqual(["remove"]);
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
		let [, chatgpt, claude] = accountRows(credentials).signIns;
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
			action: "sign-in",
			more: [],
		});
		expect(claude.name).toBe("Claude");
		expect(claude.action).toBe("sign-in");
		expect(claude.more).toEqual([]);
		expect(accountRows([]).keys.map(row => row.provider)).toEqual(["openai", "anthropic"]);
	});

	test("a connected sign-in says whose it is, nothing of when it was used, and can be disconnected", () => {
		expect(signIns([CHATGPT]).chatgpt).toEqual({
			provider: "chatgpt",
			name: "ChatGPT",
			badge: { tone: "success", label: "Connected" },
			lines: ["Your ChatGPT sign-in"],
			getCopilot: false,
			more: ["disconnect"],
		});
	});

	test("a sign-in its provider ended, or Chopin can't read, never reads as connected", () => {
		let rejectedAt = "2026-11-19T12:00:00.000Z";
		let ended = signIns([{ ...CHATGPT, provider: "claude", rejectedAt }]).claude;
		expect(ended.badge).toEqual({ tone: "warning", label: "Needs reconnecting" });
		expect(ended.lines).toEqual(["Claude ended this sign-in. Sign in again to keep using it."]);
		expect(ended.action).toBe("sign-in");
		expect(ended.more).toEqual(["disconnect"]);
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
		expect(row.action).toBeUndefined();
		expect(row.more).toEqual(["disconnect"]);
	});
});
