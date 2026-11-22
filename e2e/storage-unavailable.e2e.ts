/**
 * Chopin where the browser refuses its storage: Chrome or Edge with all site data blocked throws a
 * SecurityError from `localStorage` and `sessionStorage` themselves, a full store throws from a
 * write, and a damaged one from every call. The page still renders and every surface works, keeping
 * what it would have stored for as long as the page lasts, and says nothing about it.
 */

import { chatInput } from "./chat-input";
import { expect, ready, test } from "./room";

import type { Page } from "@playwright/test";

/** Each way a browser refuses storage, installed before any of the page's scripts run. */
const REFUSALS = {
	// Chrome's own words for a page whose site data is blocked; Edge and Safari's Block all cookies
	// refuse the same way.
	"refuses the storage itself": () => {
		for (let name of ["localStorage", "sessionStorage"]) {
			Object.defineProperty(window, name, {
				configurable: true,
				get() {
					throw new DOMException(
						`Failed to read the '${name}' property from 'Window': Access is denied for this document.`,
						"SecurityError",
					);
				},
			});
		}
	},
	// A full store, or a private window with no quota, as Safari's were.
	"keeps nothing over its quota": () => {
		Object.defineProperty(Storage.prototype, "setItem", {
			configurable: true,
			value() {
				throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
			},
		});
	},
	// A damaged profile, whose storage throws from every call, reads included.
	"throws from every call": () => {
		for (let method of ["getItem", "setItem", "removeItem", "key", "clear"] as const) {
			Object.defineProperty(Storage.prototype, method, {
				configurable: true,
				value() {
					throw new DOMException("The operation failed.", "UnknownError");
				},
			});
		}
	},
};

/**
 * Every error the page raises or logs, so one that storage throws can't go unseen. A picture that
 * fails to load (the test's people have theirs on an address that doesn't resolve) is not one.
 */
function errors(page: Page): string[] {
	let seen: string[] = [];
	page.on("pageerror", error => seen.push(`pageerror: ${error.message}`));
	page.on("console", message => {
		if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
			seen.push(`console: ${message.text()}`);
		}
	});
	return seen;
}

for (let [refusal, refuse] of Object.entries(REFUSALS)) {
	test(`everything works where the browser ${refusal}`, async ({ join, page }) => {
		await page.addInitScript(refuse);
		let seen = errors(page);

		// Signed in, with a document open and ready to type into.
		await join("ana");
		let sidebar = page.getByRole("complementary", { name: "Projects" });
		await expect(sidebar).toBeVisible();

		// The sidebar folds and comes back, a choice kept for this page.
		await sidebar.getByRole("button", { name: "Hide sidebar" }).click();
		await expect(sidebar).toBeHidden();
		await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
		await expect(sidebar).toBeVisible();

		// Chat takes a message, and Aa turns its formatting off and back on.
		let chat = page.getByRole("complementary", { name: "Chat" });
		let formatting = chat.getByRole("button", { name: "Formatting", exact: true });
		await formatting.click();
		await expect(formatting).toHaveAttribute("aria-pressed", "false");
		await formatting.click();
		await expect(formatting).toHaveAttribute("aria-pressed", "true");
		let input = chatInput(chat);
		await input.fill("Ship the export first");
		await input.press("Enter");
		let message = chat.locator("[data-chat-message-id]").filter({
			hasText: "Ship the export first",
		});
		await expect(message).toHaveCount(1);
		await expect(message.getByText("Sending", { exact: true })).toHaveCount(0);
		await expect(message.getByText("Couldn't send", { exact: false })).toHaveCount(0);

		// AI accounts, from the sidebar.
		await sidebar.getByRole("link", { name: "AI accounts", exact: true }).click();
		await expect(page.getByRole("heading", { name: "AI accounts", level: 1 })).toBeVisible();
		await expect(page.getByRole("heading", { name: "Use a subscription", level: 2 }))
			.toBeVisible();

		// The account menu's Theme draws the choice, though the browser can't keep it.
		await page.locator(".project-sidebar-account").click();
		let theme = page.getByRole("group", { name: "Theme" });
		await theme.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
		await expect(theme.getByRole("menuitemradio", { name: "Dark", exact: true }))
			.toHaveAttribute("aria-checked", "true");
		await page.keyboard.press("Escape");

		// Back to the document: it opens again, with what this page held.
		await page.goBack();
		await ready(page);
		await expect(
			chat.locator("[data-chat-message-id]").filter({
				hasText: "Ship the export first",
			}),
		).toHaveCount(1);

		// A reload forgets what only the page held, and renders as a first visit does.
		await page.reload();
		await ready(page);
		await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
		await expect(sidebar).toBeVisible();

		// Nothing is said about storage, and nothing failed.
		await expect(page.getByText(/storage|cookie/i)).toHaveCount(0);
		expect(seen).toEqual([]);
	});
}
