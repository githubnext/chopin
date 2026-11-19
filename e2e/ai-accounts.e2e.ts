import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { markAiKeyRejected, seedUnreadableAiKey } from "./database";
import { authenticate } from "./room";

import type { Page } from "@playwright/test";

const REFUSED_KEY = "sk-e2e-refused-openai-0000";

function person(prefix = "ai") {
	return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function copilotAccess(handle: string, access: "none" | "unknown" | "access") {
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
	await expect(page.getByRole("heading", { name: "Sign-ins", level: 2 })).toBeVisible();
	await expect(page.getByRole("heading", { name: "API keys", level: 2 })).toBeVisible();
});

test("GitHub Copilot through a sign-in with a seat is connected and asks for nothing", async ({ baseURL, page }) => {
	await open(page, person(), baseURL!);
	let copilot = row(page, "GitHub Copilot");
	await expect(copilot.getByText("Connected", { exact: true })).toBeVisible();
	await expect(copilot.getByText("Your GitHub sign-in", { exact: true })).toBeVisible();
	await expect(copilot.getByRole("button")).toHaveCount(0);
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
		await expect(copilot.getByRole("button", { name: "Check again" })).toBeVisible();

		await copilot.getByRole("button", { name: "Use a token instead" }).click();
		let dialog = page.getByRole("dialog", { name: "Use a GitHub token for Copilot" });
		await expect(dialog.getByLabel("GitHub token")).toBeFocused();
		await expect(dialog.getByLabel("GitHub token")).toHaveAttribute("type", "password");
		await dialog.getByLabel("GitHub token").fill("ghp_e2e_seat_token_c0de");
		await dialog.getByRole("button", { name: "Use token" }).click();
		await expect(dialog).toHaveCount(0);
		await expect(copilot.getByText("Connected", { exact: true })).toBeVisible();
		await expect(copilot.getByText("Token ending c0de", { exact: true })).toBeVisible();
		await expect(copilot.getByText("Never used", { exact: true })).toBeVisible();
		await expect(copilot.getByRole("button", { name: "Replace GitHub Copilot token" }))
			.toBeFocused();

		await copilot.getByRole("button", { name: "Use GitHub sign-in" }).click();
		await expect(copilot.getByText("No Copilot access", { exact: true })).toBeVisible();
		await expect(copilot.getByText("Token ending c0de")).toHaveCount(0);
		await expect(copilot.getByRole("button", { name: "Use a token instead" })).toBeFocused();
	} finally {
		await forgetCopilotAccess(handle);
	}
});

test("a check that couldn't finish offers Check again and never says there is no subscription", async ({ baseURL, page }) => {
	let handle = person();
	await copilotAccess(handle, "unknown");
	try {
		await open(page, handle, baseURL!);
		let copilot = row(page, "GitHub Copilot");
		await expect(copilot.getByText("Not checked", { exact: true })).toBeVisible();
		await expect(copilot.getByText("Chopin couldn't finish checking for Copilot access."))
			.toBeVisible();
		await expect(copilot).not.toContainText("subscription");
		await expect(copilot.getByRole("link", { name: "Get Copilot" })).toHaveCount(0);

		await copilotAccess(handle, "access");
		await copilot.getByRole("button", { name: "Check again" }).click();
		await expect(copilot.getByText("Connected", { exact: true })).toBeVisible();
		await expect(copilot.getByRole("button")).toHaveCount(0);
		await expect(page.getByRole("heading", { name: "AI accounts", level: 1 })).toBeFocused();
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
	await expect(openai.getByText("Connected", { exact: true })).toBeVisible();
	await expect(openai.getByText("Key ending 7Qxa", { exact: true })).toBeVisible();
	await expect(openai.getByText("Never used", { exact: true })).toBeVisible();
	await expect(openai.getByRole("button", { name: "Add key for OpenAI" })).toHaveCount(0);
	await expect(openai.getByRole("button", { name: "Replace OpenAI key" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(openai.getByRole("button", { name: "Remove OpenAI key" })).toBeFocused();

	await openai.getByRole("button", { name: "Replace OpenAI key" }).click();
	let replacing = page.getByRole("dialog", { name: "Replace OpenAI key" });
	await expect(replacing.getByLabel("API key")).toHaveValue("");
	await expect(replacing.getByLabel("API key")).toBeEditable();
	await replacing.getByLabel("API key").fill("sk-e2e-good-openai-9zz9");
	await replacing.getByRole("button", { name: "Replace key" }).click();
	await expect(replacing).toHaveCount(0);
	await expect(openai.getByText("Key ending 9zz9", { exact: true })).toBeVisible();
	await expect(openai.getByRole("button", { name: "Replace OpenAI key" })).toBeFocused();

	await openai.getByRole("button", { name: "Remove OpenAI key" }).click();
	let removing = page.getByRole("dialog", { name: "Remove OpenAI key?" });
	await expect(removing.getByRole("button", { name: "Cancel" })).toBeFocused();
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
	await expect(anthropic.getByText("Connected", { exact: true })).toBeVisible();
	await expect(anthropic.getByText("Needs reconnecting")).toHaveCount(0);
	await expect(anthropic.getByText("Key ending beef", { exact: true })).toBeVisible();
});

test("a key its provider refused says it needs reconnecting", async ({ baseURL, page }) => {
	let handle = person();
	await open(page, handle, baseURL!);
	let openai = row(page, "OpenAI");
	await openai.getByRole("button", { name: "Add key for OpenAI" }).click();
	let dialog = page.getByRole("dialog", { name: "Add OpenAI key" });
	await dialog.getByLabel("API key").fill("sk-e2e-good-openai-feed");
	await dialog.getByRole("button", { name: "Add key" }).click();
	await expect(openai.getByText("Connected", { exact: true })).toBeVisible();

	await markAiKeyRejected(Number(new URL(baseURL!).port), handle, "openai");
	await page.reload();
	await expect(openai.getByText("Needs reconnecting", { exact: true })).toBeVisible();
	await expect(openai.getByText("OpenAI no longer accepts this key. Replace it to keep using it."))
		.toBeVisible();
	await expect(openai.getByRole("button", { name: "Replace OpenAI key" })).toBeVisible();
	await expect(openai.getByRole("button", { name: "Remove OpenAI key" })).toBeVisible();
});
