import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { markAiKeyRejected, seedUnreadableAiKey } from "./database";
import { authenticate } from "./room";

import type { Locator, Page, Request } from "@playwright/test";

const REFUSED_KEY = "sk-e2e-refused-openai-0000";

function person(prefix = "ai") {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function copilotAccess(handle: string, access: "none" | "unknown" | "access" | "refused") {
	let gates = join(tmpdir(), "chopin-e2e-copilot");
	await mkdir(gates, { recursive: true });
	await writeFile(join(gates, handle), access);
}

async function forgetCopilotAccess(handle: string) {
	await rm(join(tmpdir(), "chopin-e2e-copilot", handle), { force: true });
}

function sidebar(page: Page) {
	return page.getByRole("complementary", { name: "Projects" });
}

function row(page: Page, name: string) {
	return page.getByRole("main").getByRole("listitem").filter({
		has: page.getByRole("heading", { name, exact: true }),
	});
}

/** A connected account's row: Connected and its one line, never when it was last used. */
async function expectConnected(account: Locator, line: string) {
	await expect(account.getByText("Connected", { exact: true })).toBeVisible();
	await expect(account.getByRole("paragraph")).toHaveText([line]);
}

/** A row's menu button: everything but the action its state asks for is in its menu. */
function more(account: Locator) {
	return account.getByRole("button", { name: /^More actions for / });
}

function menu(page: Page) {
	return page.getByRole("menu", { name: /^More actions for / });
}

/** Opens a row's menu and chooses one of its actions. */
async function choose(page: Page, account: Locator, action: string) {
	await more(account).click();
	await menu(page).getByRole("menuitem", { name: action, exact: true }).click();
}

/** The row's menu offers exactly these actions; Escape closes it and returns to its button. */
async function expectMenu(page: Page, account: Locator, actions: string[]) {
	await more(account).click();
	await expect(menu(page).getByRole("menuitem")).toHaveText(actions);
	await page.keyboard.press("Escape");
	await expect(menu(page)).toHaveCount(0);
	await expect(more(account)).toBeFocused();
}

async function open(page: Page, handle: string, baseURL: string) {
	await authenticate(page, handle, baseURL);
	await page.goto("/ai-accounts");
	await expect(page.getByRole("heading", { name: "AI accounts", level: 1 })).toBeVisible();
}

test("AI accounts sits in the sidebar directly under Machines and opens its page", async ({ baseURL, page }) => {
	await authenticate(page, person(), baseURL!);
	await page.goto("/machines");
	let entry = sidebar(page).getByRole("link", { name: "AI accounts", exact: true });
	await expect(entry).toBeVisible();
	expect(
		await entry.evaluate(element =>
			element.previousElementSibling?.getAttribute("aria-label")?.startsWith("Machines")
		),
	).toBe(true);
	await expect(entry).not.toHaveAttribute("aria-current", "page");

	await entry.click();
	await expect(page).toHaveURL(/\/ai-accounts$/);
	await expect(entry).toHaveAttribute("aria-current", "page");
	await expect(page.getByRole("heading", { name: "AI accounts", level: 1 })).toBeFocused();
	await expect(page.getByRole("main")).toContainText(
		"chopin uses these to work for you on any machine. Machines get a stand-in, never the key itself.",
	);
	await expect(page.getByRole("heading", { name: "Use a subscription", level: 2 })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Use an API key", level: 2 })).toBeVisible();
});

test("GitHub Copilot through a sign-in with a seat is connected, takes a token instead, and goes back to the sign-in", async ({ baseURL, page }) => {
	await open(page, person(), baseURL!);
	let copilot = row(page, "GitHub Copilot");
	await expectConnected(copilot, "Your GitHub sign-in");
	await expect(copilot.getByRole("button")).toHaveCount(1);
	await expect(more(copilot)).toHaveAccessibleName("More actions for GitHub Copilot");
	await expectMenu(page, copilot, ["Use a token instead"]);

	await choose(page, copilot, "Use a token instead");
	let dialog = page.getByRole("dialog", { name: "Use a GitHub token for Copilot" });
	let field = dialog.getByLabel("GitHub token");
	await expect(field).toBeFocused();
	await expect(field).toHaveAccessibleDescription(
		"A fine-grained personal access token with the Copilot Requests permission, or the GitHub CLI's (gh auth token).",
	);
	await field.fill("github_pat_e2e_other_account_9a9a");
	await dialog.getByRole("button", { name: "Use token" }).click();
	await expect(dialog).toHaveCount(0);
	await expectConnected(copilot, "Token ending 9a9a");
	await expect(more(copilot)).toBeFocused();
	await expectMenu(page, copilot, ["Replace", "Use GitHub sign-in"]);

	await page.reload();
	await expect(copilot.getByText("Token ending 9a9a", { exact: true })).toBeVisible();
	await choose(page, copilot, "Use GitHub sign-in");
	await expectConnected(copilot, "Your GitHub sign-in");
	await expect(more(copilot)).toBeFocused();
});

test("a token GitHub refuses for Copilot is said under the field and leaves the sign-in in place", async ({ baseURL, page }) => {
	await open(page, person(), baseURL!);
	let copilot = row(page, "GitHub Copilot");
	await expectConnected(copilot, "Your GitHub sign-in");
	await choose(page, copilot, "Use a token instead");
	let dialog = page.getByRole("dialog", { name: "Use a GitHub token for Copilot" });
	let field = dialog.getByLabel("GitHub token");
	await field.fill("gho_e2e_refused_token_dead");
	await dialog.getByRole("button", { name: "Use token" }).click();
	let refusal = "GitHub refused this token for Copilot. Check it and try again.";
	await expect(dialog.getByRole("alert")).toHaveText(refusal);
	await expect(field).toHaveAttribute("aria-invalid", "true");
	await expect(field).toHaveAccessibleDescription(new RegExp(`Copilot Requests.*${refusal}`));
	let listed = await page.evaluate(async () => await (await fetch("/api/ai/credentials")).text());
	expect(listed).toContain('"kind":"github-sign-in"');
	expect(listed).not.toContain("dead");

	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expectConnected(copilot, "Your GitHub sign-in");
	await expect(more(copilot)).toBeFocused();
	await page.reload();
	await expect(copilot.getByText("Your GitHub sign-in", { exact: true })).toBeVisible();
	await expect(copilot.getByText("Token ending dead")).toHaveCount(0);
});

test("without a seat, Copilot says so, links to Copilot, and takes a token instead", async ({ baseURL, page }) => {
	let handle = person();
	await copilotAccess(handle, "none");
	try {
		await open(page, handle, baseURL!);
		let copilot = row(page, "GitHub Copilot");
		await expect(copilot.getByText("No Copilot access", { exact: true })).toBeVisible();
		await expect(copilot.getByText("Your GitHub account has no Copilot subscription."))
			.toBeVisible();
		await expect(copilot.getByRole("link", { name: "Get Copilot" }))
			.toHaveAttribute("href", "https://github.com/features/copilot");
		await expect(copilot.getByRole("button", { name: "Check again" })).toHaveCount(0);

		await choose(page, copilot, "Use a token instead");
		let dialog = page.getByRole("dialog", { name: "Use a GitHub token for Copilot" });
		await expect(dialog.getByLabel("GitHub token")).toBeFocused();
		await expect(dialog.getByLabel("GitHub token")).toHaveAttribute("type", "password");
		await dialog.getByLabel("GitHub token").fill("ghp_e2e_seat_token_c0de");
		await dialog.getByRole("button", { name: "Use token" }).click();
		await expect(dialog).toHaveCount(0);
		await expectConnected(copilot, "Token ending c0de");
		await expect(more(copilot)).toBeFocused();

		await choose(page, copilot, "Use GitHub sign-in");
		await expect(copilot.getByText("No Copilot access", { exact: true })).toBeVisible();
		await expect(copilot.getByText("Token ending c0de")).toHaveCount(0);
		await expect(more(copilot)).toBeFocused();
	} finally {
		await forgetCopilotAccess(handle);
	}
});

test("a seat-holder whose sign-in GitHub won't exchange is connected through Copilot's own API, never told there is no subscription", async ({ baseURL, page }) => {
	let handle = person();
	await copilotAccess(handle, "refused");
	try {
		await open(page, handle, baseURL!);
		let copilot = row(page, "GitHub Copilot");
		await expectConnected(copilot, "Your GitHub sign-in");
		await expect(copilot).not.toContainText("subscription");
		await expectMenu(page, copilot, ["Use a token instead"]);
	} finally {
		await forgetCopilotAccess(handle);
	}
});

test("a check that couldn't finish never says there is no subscription, and is done again when the page opens", async ({ baseURL, page }) => {
	let handle = person();
	await copilotAccess(handle, "unknown");
	try {
		await open(page, handle, baseURL!);
		let copilot = row(page, "GitHub Copilot");
		await expect(copilot.getByText("Not checked", { exact: true })).toBeVisible();
		await expect(
			copilot.getByText(
				"Chopin couldn't check for Copilot access through your GitHub sign-in. It checks again when you open this page.",
			),
		).toBeVisible();
		await expect(copilot).not.toContainText("subscription");
		await expect(copilot.getByRole("link", { name: "Get Copilot" })).toHaveCount(0);
		await expectMenu(page, copilot, ["Use a token instead"]);

		await copilotAccess(handle, "access");
		await page.reload();
		await expectConnected(copilot, "Your GitHub sign-in");
		await expectMenu(page, copilot, ["Use a token instead"]);
	} finally {
		await forgetCopilotAccess(handle);
	}
});

test("a key is checked before it is saved, then replaced and removed", async ({ baseURL, page }) => {
	await open(page, person(), baseURL!);
	let openai = row(page, "OpenAI");
	await expect(openai.getByText("Use OpenAI models with your own key.")).toBeVisible();
	await expect(row(page, "Anthropic").getByRole("button", { name: "Add key for Anthropic" }))
		.toBeVisible();

	await openai.getByRole("button", { name: "Add key for OpenAI" }).click();
	let dialog = page.getByRole("dialog", { name: "Add OpenAI key" });
	let field = dialog.getByLabel("API key");
	await expect(field).toBeFocused();
	await expect(field).toHaveAttribute("type", "password");
	await field.fill(REFUSED_KEY);
	await dialog.getByRole("button", { name: "Add key" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"OpenAI refused this key. Check it and try again.",
	);
	await expect(field).toHaveAttribute("aria-invalid", "true");
	await expect(field).toHaveAccessibleDescription(
		"OpenAI refused this key. Check it and try again.",
	);
	let listed = await page.evaluate(async () => await (await fetch("/api/ai/credentials")).text());
	expect(listed).not.toContain("openai");
	expect(listed).not.toContain(REFUSED_KEY);

	await field.fill("sk-e2e-good-openai-7Qxa");
	await expect(field).not.toHaveAttribute("aria-invalid", "true");
	await dialog.getByRole("button", { name: "Add key" }).click();
	await expect(dialog).toHaveCount(0);
	await expectConnected(openai, "Key ending 7Qxa");
	await expect(openai.getByRole("button", { name: "Add key for OpenAI" })).toHaveCount(0);
	await expect(more(openai)).toBeFocused();
	await expect(more(openai)).toHaveAccessibleName("More actions for OpenAI");
	// The keys of the shared menu: Down opens it on its first item, the arrows move, Escape returns.
	await page.keyboard.press("ArrowDown");
	let actions = menu(page).getByRole("menuitem");
	await expect(actions).toHaveText(["Replace", "Remove"]);
	await expect(actions.first()).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(actions.last()).toBeFocused();
	await expect(actions.last()).toHaveAttribute("data-tone", "destructive");
	await page.keyboard.press("Escape");
	await expect(menu(page)).toHaveCount(0);
	await expect(more(openai)).toBeFocused();

	await choose(page, openai, "Replace");
	let replacing = page.getByRole("dialog", { name: "Replace OpenAI key" });
	await expect(replacing.getByLabel("API key")).toHaveValue("");
	await expect(replacing.getByLabel("API key")).toBeEditable();
	await replacing.getByLabel("API key").fill("sk-e2e-good-openai-9zz9");
	await replacing.getByRole("button", { name: "Replace key" }).click();
	await expect(replacing).toHaveCount(0);
	await expect(openai.getByText("Key ending 9zz9", { exact: true })).toBeVisible();
	await expect(more(openai)).toBeFocused();

	await choose(page, openai, "Remove");
	let removing = page.getByRole("dialog", { name: "Remove OpenAI key?" });
	await expect(removing.getByRole("button", { name: "Cancel" })).toBeFocused();
	await removing.getByRole("button", { name: "Cancel" }).click();
	await expect(removing).toHaveCount(0);
	await expect(more(openai)).toBeFocused();
	await choose(page, openai, "Remove");
	await removing.getByRole("button", { name: "Remove key" }).click();
	await expect(removing).toHaveCount(0);
	await expect(openai.getByRole("button", { name: "Add key for OpenAI" })).toBeVisible();
	await expect(openai.getByText("Key ending 9zz9")).toHaveCount(0);
	await expect(openai.getByRole("button", { name: "Add key for OpenAI" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(row(page, "Anthropic").getByRole("button", { name: "Add key for Anthropic" }))
		.toBeFocused();

	await page.reload();
	await expect(row(page, "OpenAI").getByRole("button", { name: "Add key for OpenAI" }))
		.toBeVisible();
});

test("a key Chopin can no longer read says it needs reconnecting until it is replaced", async ({ baseURL, page }) => {
	let handle = person();
	await authenticate(page, handle, baseURL!);
	await seedUnreadableAiKey(Number(new URL(baseURL!).port), handle, "anthropic", "dead");
	await page.goto("/ai-accounts");
	let anthropic = row(page, "Anthropic");
	await expect(anthropic.getByText("Needs reconnecting", { exact: true })).toBeVisible();
	await expect(anthropic.getByText("Key ending dead", { exact: true })).toBeVisible();
	await expect(
		anthropic.getByText("Chopin can't read this key anymore. Replace it to keep using it."),
	).toBeVisible();
	await expect(anthropic.getByText("Connected", { exact: true })).toHaveCount(0);

	await anthropic.getByRole("button", { name: "Replace Anthropic key" }).click();
	let dialog = page.getByRole("dialog", { name: "Replace Anthropic key" });
	await dialog.getByLabel("API key").fill("sk-e2e-good-anthropic-beef");
	await dialog.getByRole("button", { name: "Replace key" }).click();
	await expect(dialog).toHaveCount(0);
	await expectConnected(anthropic, "Key ending beef");
});

test("a key its provider refused says it needs reconnecting", async ({ baseURL, page }) => {
	let handle = person();
	await open(page, handle, baseURL!);
	let openai = row(page, "OpenAI");
	await openai.getByRole("button", { name: "Add key for OpenAI" }).click();
	let dialog = page.getByRole("dialog", { name: "Add OpenAI key" });
	await dialog.getByLabel("API key").fill("sk-e2e-good-openai-feed");
	await dialog.getByRole("button", { name: "Add key" }).click();
	await expectConnected(openai, "Key ending feed");

	await markAiKeyRejected(Number(new URL(baseURL!).port), handle, "openai");
	await page.reload();
	await expect(openai.getByText("Needs reconnecting", { exact: true })).toBeVisible();
	await expect(openai.getByText("OpenAI no longer accepts this key. Replace it to keep using it."))
		.toBeVisible();
	await expect(openai.getByRole("button", { name: "Replace OpenAI key" })).toBeVisible();
	await expectMenu(page, openai, ["Remove"]);
});

const COPILOT_CHECK = "/api/ai/credentials/github-copilot/check";

function isCheck(request: Request) {
	return request.method() === "POST" && new URL(request.url()).pathname === COPILOT_CHECK;
}

/** Holds the page's Copilot check in the browser until `release`, then sends it to Chopin. */
async function holdCheck(page: Page) {
	let release!: () => void;
	let held = new Promise<void>(resolve => (release = resolve));
	let seen!: () => void;
	let sent = new Promise<void>(resolve => (seen = resolve));
	await page.route(`**${COPILOT_CHECK}`, async route => {
		seen();
		await held;
		await route.continue();
	});
	return { sent, release };
}

test("opening the page checks Copilot once, and again each time it is opened in place", async ({ baseURL, page }) => {
	let handle = person();
	await copilotAccess(handle, "access");
	try {
		let checks = 0;
		page.on("request", request => {
			if (isCheck(request)) checks++;
		});
		await authenticate(page, handle, baseURL!);
		await page.goto("/machines");
		let entry = sidebar(page).getByRole("link", { name: "AI accounts", exact: true });
		let copilot = row(page, "GitHub Copilot");

		let answered = page.waitForResponse(response => isCheck(response.request()));
		await entry.click();
		expect((await answered).ok()).toBe(true);
		await expectConnected(copilot, "Your GitHub sign-in");
		expect(checks).toBe(1);

		await page.evaluate(() => Object.assign(window, { stillThisPage: true }));
		await page.goBack();
		await expect(page).toHaveURL(/\/machines$/);
		answered = page.waitForResponse(response => isCheck(response.request()));
		await entry.click();
		await (await answered).finished();
		await expectConnected(copilot, "Your GitHub sign-in");
		expect(await page.evaluate(() => "stillThisPage" in window)).toBe(true);
		expect(checks).toBe(2);
	} finally {
		await forgetCopilotAccess(handle);
	}
});

test("a seat lost between two visits shows on the second, the earlier answer standing while it is checked", async ({ baseURL, page }) => {
	let handle = person();
	await copilotAccess(handle, "access");
	try {
		await authenticate(page, handle, baseURL!);
		await page.goto("/machines");
		let entry = sidebar(page).getByRole("link", { name: "AI accounts", exact: true });
		let copilot = row(page, "GitHub Copilot");
		let answered = page.waitForResponse(response => isCheck(response.request()));
		await entry.click();
		await (await answered).finished();
		await expectConnected(copilot, "Your GitHub sign-in");

		await page.goBack();
		await expect(page).toHaveURL(/\/machines$/);
		await copilotAccess(handle, "none");
		let check = await holdCheck(page);
		await entry.click();
		await check.sent;
		await expectConnected(copilot, "Your GitHub sign-in");
		await expect(copilot.getByText("Checking…")).toHaveCount(0);

		check.release();
		await expect(copilot.getByText("No Copilot access", { exact: true })).toBeVisible();
		await expect(copilot.getByText("Your GitHub account has no Copilot subscription."))
			.toBeVisible();
		await expectMenu(page, copilot, ["Use a token instead"]);
	} finally {
		await forgetCopilotAccess(handle);
	}
});

test("with no earlier answer, Copilot says it is checking until the check answers", async ({ baseURL, page }) => {
	let handle = person();
	await copilotAccess(handle, "unknown");
	try {
		await authenticate(page, handle, baseURL!);
		let check = await holdCheck(page);
		await page.goto("/ai-accounts");
		await check.sent;
		let copilot = row(page, "GitHub Copilot");
		await expect(copilot.getByText("Checking…", { exact: true })).toBeVisible();
		await expect(copilot.getByText("Your GitHub sign-in", { exact: true })).toBeVisible();
		await expect(copilot.getByText("Not checked")).toHaveCount(0);
		await expect(copilot.getByRole("button")).toHaveCount(1);
		await expect(more(copilot)).toHaveAccessibleName("More actions for GitHub Copilot");

		await copilotAccess(handle, "access");
		check.release();
		await expectConnected(copilot, "Your GitHub sign-in");
		await expect(copilot.getByText("Checking…")).toHaveCount(0);
	} finally {
		await forgetCopilotAccess(handle);
	}
});

test("Sign in with ChatGPT takes the address the browser ends on, then connects and disconnects", async ({ baseURL, page }) => {
	await open(page, person(), baseURL!);
	await expect(page.getByRole("heading", { name: "Use a subscription", level: 2 }))
		.toBeVisible();
	let chatgpt = row(page, "ChatGPT");
	await expect(chatgpt.getByText("Use OpenAI models with your ChatGPT plan.")).toBeVisible();

	await chatgpt.getByRole("button", { name: "Sign in to ChatGPT" }).click();
	let dialog = page.getByRole("dialog", { name: "Sign in with ChatGPT" });
	let opener = dialog.getByRole("link", { name: "Open ChatGPT sign-in" });
	await expect(opener).toHaveAttribute(
		"href",
		/^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/,
	);
	await expect(opener).toBeFocused();
	await expect(opener).toHaveAttribute("target", "_blank");
	let authorize = new URL((await opener.getAttribute("href"))!);
	expect(authorize.searchParams.get("client_id")).toBe("dynamic_agent_client");
	expect(authorize.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1455/auth/callback");
	expect(authorize.searchParams.get("resource")).toBe("https://api.openai.com/v1");
	expect(authorize.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
	expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
	expect(authorize.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
	let state = authorize.searchParams.get("state")!;

	let field = dialog.getByLabel("Address after signing in");
	await expect(field).toHaveAccessibleDescription(/page at 127\.0\.0\.1/);
	await field.fill("https://chatgpt.com/");
	await dialog.getByRole("button", { name: "Connect" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"The address you paste starts with http://127.0.0.1:1455/auth/callback.",
	);
	await expect(field).toHaveAttribute("aria-invalid", "true");

	await field.fill(
		`http://127.0.0.1:1455/auth/callback?code=e2e-chatgpt-code&state=another&client_id=app_e2e`,
	);
	await dialog.getByRole("button", { name: "Connect" }).click();
	await expect(dialog.getByRole("alert")).toContainText("from another sign-in");

	await field.fill(
		`http://127.0.0.1:1455/auth/callback?code=e2e-chatgpt-code&state=${state}&client_id=app_e2e`,
	);
	await dialog.getByRole("button", { name: "Connect" }).click();
	await expect(dialog).toHaveCount(0);
	await expectConnected(chatgpt, "Your ChatGPT sign-in");
	await expect(more(chatgpt)).toBeFocused();
	let listed = await page.evaluate(async () => await (await fetch("/api/ai/credentials")).text());
	expect(listed).toContain('"chatgpt"');
	expect(listed).not.toContain("e2e-chatgpt-access");
	expect(listed).not.toContain("e2e-chatgpt-refresh");

	await choose(page, chatgpt, "Disconnect");
	let disconnecting = page.getByRole("dialog", { name: "Disconnect ChatGPT?" });
	await expect(disconnecting.getByRole("button", { name: "Cancel" })).toBeFocused();
	await disconnecting.getByRole("button", { name: "Disconnect" }).click();
	await expect(disconnecting).toHaveCount(0);
	await expect(chatgpt.getByRole("button", { name: "Sign in to ChatGPT" })).toBeFocused();
	await expect(chatgpt.getByText("Connected", { exact: true })).toHaveCount(0);
});

test("Claude's sign-in takes the code Claude shows, and a refused code starts a fresh sign-in", async ({ baseURL, page }) => {
	await open(page, person(), baseURL!);
	let claude = row(page, "Claude");
	await expect(claude.getByText("Use Claude models with your Claude plan.")).toBeVisible();

	await claude.getByRole("button", { name: "Sign in to Claude" }).click();
	let dialog = page.getByRole("dialog", { name: "Sign in with Claude" });
	let opener = dialog.getByRole("link", { name: "Open Claude sign-in" });
	await expect(opener).toHaveAttribute("href", /^https:\/\/claude\.ai\/oauth\/authorize\?/);
	let first = new URL((await opener.getAttribute("href"))!);
	expect(first.searchParams.get("code")).toBe("true");
	expect(first.searchParams.get("redirect_uri"))
		.toBe("https://platform.claude.com/oauth/code/callback");
	expect(first.searchParams.get("scope")).toContain("user:inference");
	expect(first.searchParams.get("code_challenge_method")).toBe("S256");

	let field = dialog.getByLabel("Code from Claude");
	await field.fill(`e2e-claude-refused#${first.searchParams.get("state")}`);
	await dialog.getByRole("button", { name: "Connect" }).click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Claude didn't accept this sign-in. Start again.",
	);
	await expect(field).toHaveValue("");
	await expect(opener).not.toHaveAttribute("href", first.toString());
	await expect(opener).toBeFocused();
	let second = new URL((await opener.getAttribute("href"))!);
	expect(second.searchParams.get("state")).not.toBe(first.searchParams.get("state"));

	await field.fill(`e2e-claude-code#${second.searchParams.get("state")}`);
	await dialog.getByRole("button", { name: "Connect" }).click();
	await expect(dialog).toHaveCount(0);
	await expectConnected(claude, "Your Claude sign-in");
	await expect(row(page, "Anthropic").getByRole("button", { name: "Add key for Anthropic" }))
		.toBeVisible();
});
