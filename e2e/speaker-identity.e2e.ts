import AxeBuilder from "@axe-core/playwright";

import { childDocumentPath } from "../packages/protocol/document-url";
import { chatInput } from "./chat-input";
import { seedLinkedChildChannel, testChannelSlug } from "./database";
import { expectNoHorizontalOverflow } from "./responsive";
import { expect, openIsolatedRoom, test } from "./room";

import type { BrowserContext, Locator, Page } from "@playwright/test";

function tile(fill: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="${fill}"/></svg>`;
}

const STORED: Record<string, string> = {
	mona_acme: tile("#2b6cb0"),
	hubot_acme: tile("#b7791f"),
};

async function stubPictures(context: BrowserContext, guessed: string[]): Promise<void> {
	await context.route("https://example.invalid/*.png", route => {
		let login = new URL(route.request().url()).pathname.slice(1, -4);
		return route.fulfill({
			contentType: "image/svg+xml",
			body: STORED[login] ?? tile("#666666"),
		});
	});
	await context.route("https://github.com/*.png*", route => {
		guessed.push(route.request().url());
		return route.fulfill({ contentType: "image/svg+xml", body: tile("#cc0000") });
	});
}

function chat(page: Page): Locator {
	return page.getByRole("complementary", { name: "Chat" });
}

function portOf(baseURL: string): number {
	return Number(new URL(baseURL).port);
}

/** The size and corner of what a row draws in its avatar gutter. */
async function avatarGeometry(badge: Locator) {
	return badge.evaluate(element => {
		let rect = element.getBoundingClientRect();
		let style = getComputedStyle(element);
		return {
			width: Math.round(rect.width),
			height: Math.round(rect.height),
			radius: parseFloat(style.borderTopLeftRadius),
			backgroundColor: style.backgroundColor,
		};
	});
}

test(
	"two people speak in Slack rows with their stored GitHub pictures, untagged, and consecutive lines grouped",
	async ({ baseURL, browser, room }) => {
		let guessed: string[] = [];
		let opened: Array<{ close: () => Promise<void> }> = [];
		let join = async (login: string) => {
			let session = await openIsolatedRoom(
				browser,
				baseURL!,
				room,
				login,
				{},
				context => stubPictures(context, guessed),
			);
			opened.push(session);
			return session.page;
		};
		try {
			let mona = await join("mona_acme");
			let hubot = await join("hubot_acme");

			await chatInput(chat(mona)).fill("Morning, Hubot.");
			await chat(mona).getByRole("button", { name: "Send message" }).click();
			await expect(chat(hubot).getByText("Morning, Hubot.")).toBeVisible();

			await chatInput(chat(mona)).fill("Let us keep the rollout simple.");
			await chat(mona).getByRole("button", { name: "Send message" }).click();
			await expect(chat(hubot).getByText("Let us keep the rollout simple.")).toBeVisible();

			await chatInput(chat(hubot)).fill("Agreed, one stage first.");
			await chat(hubot).getByRole("button", { name: "Send message" }).click();
			await expect(chat(mona).getByText("Agreed, one stage first.")).toBeVisible();

			for (let page of [mona, hubot]) {
				let entries = chat(page).locator('[data-chat-entry][data-speaker-kind="user"]');
				await expect(entries).toHaveCount(2);

				let monaRow = entries.nth(0);
				await expect(monaRow.locator("[data-speaker-name]")).toHaveText("mona_acme");
				await expect(monaRow.locator("[data-speaker-name]")).toHaveCSS("font-weight", "700");
				// A person is never tagged: only an app is.
				await expect(monaRow.locator("[data-speaker-tag]")).toHaveCount(0);

				let monaImg = monaRow.locator("[data-chat-avatar] img");
				await expect(monaImg).toHaveAttribute("src", "https://example.invalid/mona_acme.png");
				await expect.poll(() => monaImg.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(
					40,
				);
				let monaAvatar = await avatarGeometry(monaRow.locator("[data-chat-avatar] > *").first());
				expect([monaAvatar.width, monaAvatar.height]).toEqual([36, 36]);

				// Consecutive messages from Mona share one name line and align in one column.
				let bodies = monaRow.locator(".chat-message-body");
				await expect(bodies).toHaveCount(2);
				await expect(monaRow.locator("[data-chat-head]")).toHaveCount(1);
				let [firstX, secondX] = await Promise.all([
					bodies.nth(0).evaluate(el => Math.round(el.getBoundingClientRect().x)),
					bodies.nth(1).evaluate(el => Math.round(el.getBoundingClientRect().x)),
				]);
				expect(secondX).toBe(firstX);

				let hubotRow = entries.nth(1);
				await expect(hubotRow.locator("[data-speaker-name]")).toHaveText("hubot_acme");
				let hubotImg = hubotRow.locator("[data-chat-avatar] img");
				await expect(hubotImg).toHaveAttribute("src", "https://example.invalid/hubot_acme.png");
				await expect.poll(() => hubotImg.evaluate((img: HTMLImageElement) => img.naturalWidth))
					.toBe(40);
			}
			expect(guessed).toEqual([]);
		} finally {
			await Promise.all(opened.map(session => session.close()));
		}
	},
);

test(
	"the Planner, a research child and each tool call are tagged the way Slack tags apps, with keyboard disclosure, a phone and axe",
	async ({ baseURL, join, room, seed }) => {
		let childId = crypto.randomUUID();
		let childSlug = `child-${childId.slice(0, 8)}`;
		let childHref = childDocumentPath(
			"octo-org",
			"score",
			testChannelSlug(room),
			childSlug,
		);

		await seed("# Parent plan\n\nDeciding on search infrastructure.\n", {
			transcript: [
				{
					id: "msg-mona",
					author: { kind: "member", handle: "mona_acme" },
					text: "Can we check self-hosted search options?",
					ts: 1_700_000_000,
				},
				{
					id: "msg-chopin",
					author: { kind: "agent" },
					text: "I checked the plan and started a research child document.",
					ts: 1_700_000_010,
					tools: [
						{
							id: "tool-read",
							name: "read_plan",
							status: "done",
							args: '{"section":"infrastructure"}',
							result: "Current plan lists search as undecided.",
							took: 42,
						},
						{
							id: "tool-research",
							name: "create_research_workspace",
							status: "done",
							args: JSON.stringify({ question: "Compare self-hosted search engines" }),
							result: "Workspace queued.",
							took: 85,
						},
						{
							id: "tool-fetch",
							name: "fetch_repository",
							status: "failed",
							error: { code: "timeout", kind: "TimeoutError" },
							result: "Timed out reading remote refs.",
							took: 120,
						},
					],
				},
				{
					id: "notice-ready",
					author: { kind: "system" },
					text: `Research is ready. [Open the research document](${childHref}).`,
					ts: 1_700_000_030,
				},
			],
		});
		let child = await seedLinkedChildChannel(
			portOf(baseURL!),
			room,
			childId,
			"Search options report",
			"# Search options report\n\nEvaluated three self-hosted search engines.\n",
		);

		let page = await join("mona_acme");
		let pane = chat(page);

		// People: Mona's question and the linked child's reference row, neither tagged.
		let userRows = pane.locator('[data-chat-entry][data-speaker-kind="user"]');
		await expect(userRows).toHaveCount(2);
		await expect(userRows.locator("[data-speaker-tag]")).toHaveCount(0);

		// The Planner: Chopin's mark as a 36px app avatar, and the Agent tag beside its name.
		let agentRow = pane.locator('[data-chat-entry][data-speaker-kind="agent"]');
		await expect(agentRow).toHaveCount(1);
		await expect(agentRow.locator("[data-speaker-name]")).toHaveText("chopin");
		let agentTag = agentRow.locator('[data-chat-head] [data-speaker-tag="agent"]');
		await expect(agentTag).toHaveText("Agent");
		await expect(agentTag).toHaveCSS("text-transform", "uppercase");
		let tag = await avatarGeometry(agentTag);
		expect(tag.radius).toBe(4);
		expect(tag.height).toBeLessThan(20);
		let agentAvatar = await avatarGeometry(agentRow.locator("[data-chat-avatar] > *").first());
		expect([agentAvatar.width, agentAvatar.height, agentAvatar.radius]).toEqual([36, 36, 6]);
		let handoff = agentRow.getByRole("group", { name: "Research handoff" })
			.locator('[data-slot="agent-handoff"]');
		await expect(handoff).toBeVisible();
		await expect(handoff).toContainText("chopin");
		await expect(handoff).toContainText("Research");
		await expect(handoff).toContainText("Compare self-hosted search engines");

		// The research child: its own app avatar and the Subagent tag.
		let subagentRow = pane.locator('[data-speaker-kind="subagent"]');
		await expect(subagentRow).toHaveCount(1);
		await expect(subagentRow.locator("[data-speaker-name]")).toHaveText("Research");
		await expect(subagentRow.locator('[data-speaker-tag="subagent"]')).toHaveText("Subagent");
		let subagentAvatar = await avatarGeometry(subagentRow.locator("[data-app-avatar]"));
		expect([subagentAvatar.width, subagentAvatar.height, subagentAvatar.radius]).toEqual([
			36,
			36,
			6,
		]);
		// Its name line starts where every other speaker's does.
		let [agentName, childName] = await Promise.all([
			agentRow.locator("[data-speaker-name]").boundingBox(),
			subagentRow.locator("[data-speaker-name]").boundingBox(),
		]);
		expect(Math.round(childName!.x)).toBe(Math.round(agentName!.x));

		// Each tool call, opened from the keyboard, is a line tagged Tool in Slack's attachment.
		let summaryButton = agentRow.getByRole("button", { name: /Used 3 tools/ });
		await summaryButton.focus();
		await page.keyboard.press("Enter");
		let toolList = agentRow.getByRole("list", { name: "Tool calls" });
		await expect(toolList).toBeVisible();
		let tools = toolList.getByRole("listitem");
		await expect(tools).toHaveCount(3);
		await expect(toolList.locator('[data-speaker-tag="tool"]')).toHaveText([
			"Tool",
			"Tool",
			"Tool",
		]);

		let readTrigger = toolList.getByRole("button", { name: /Read plan/ });
		await expect(readTrigger).toContainText("42ms");
		await readTrigger.focus();
		await page.keyboard.press("Enter");
		let readDetails = page.locator(`[id="${await readTrigger.getAttribute("aria-controls")}"]`);
		await expect(readDetails).toContainText("Current plan lists search as undecided.");

		let failedTrigger = toolList.getByRole("button", { name: /Fetch repository/ });
		await expect(failedTrigger).toContainText("Failed");

		// Axe on the live transcript.
		let axe = await new AxeBuilder({ page })
			.include("[data-chat-stack]")
			// Colour contrast for Chat and its copied elements is checked by e2e/design/contrast.e2e.ts.
			.disableRules(["color-contrast"])
			.analyze();
		expect(axe.violations.map(v => `${v.id}: ${v.help}`)).toEqual([]);
		// The tags themselves are read, so their words must stand out from their box.
		let tagContrast = await new AxeBuilder({ page })
			.include("[data-speaker-tag]")
			.withRules(["color-contrast"])
			.analyze();
		expect(tagContrast.violations.map(v => `${v.id}: ${v.help}`)).toEqual([]);

		// A phone (390x844): every kind fits the pane with nothing scrolling sideways.
		await page.setViewportSize({ width: 390, height: 844 });
		let phoneNav = page.getByRole("navigation", { name: "Workspace view" });
		if (await phoneNav.isVisible()) {
			let chatTab = phoneNav.getByRole("button", { name: /^Chat\b/ });
			if ((await chatTab.getAttribute("aria-pressed")) !== "true") {
				await chatTab.click();
			}
		}
		await expect(subagentRow).toBeVisible();
		await expect(tools).toHaveCount(3);
		await expectNoHorizontalOverflow(page);

		// The research child's link opens the child document in this tab, as Chopin's own links do,
		// and Back returns to the document and its Chat.
		await page.setViewportSize({ width: 1280, height: 800 });
		let childLink = subagentRow.getByRole("link", { name: "Open the research document" });
		await expect(childLink).toHaveAttribute("href", childHref);
		await expect(childLink).not.toHaveAttribute("target", "_blank");
		let documentUrl = page.url();
		let tabs = page.context().pages().length;
		await childLink.click();
		await expect(page).toHaveURL(new RegExp(`/children/${child.slug}$`));
		expect(page.context().pages()).toHaveLength(tabs);
		await page.goBack();
		await expect(page).toHaveURL(documentUrl);
		await expect(subagentRow).toBeVisible();
	},
);
