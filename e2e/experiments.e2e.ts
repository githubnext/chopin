import { performance } from "../packages/experiment/src/fixtures";
import { testChannelPath } from "./database";
import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

/** A connection serves every document in its repository, so each pairing test is its own person. */
function person() {
	return `ana-${crypto.randomUUID().slice(0, 8)}`;
}

const PASSAGE = "Compare measured startup time.";

/** The investigation card whose brief this is. */
function card(page: Page, brief: string) {
	return page.getByRole("article", { name: "Investigation", exact: true }).filter({
		hasText: brief,
	});
}

/**
 * Type `/investigate` on a new line after a prose passage, write the brief, and return the
 * created record. The passage keeps the caret in text, clear of cards and embedded evidence.
 */
async function investigate(page: Page, room: string, brief: string, after: string) {
	await content(page).getByText(after, { exact: true }).click();
	await page.keyboard.press("End");
	await page.keyboard.press("Enter");
	await page.keyboard.type("/investigate");
	await page.getByRole("listbox", { name: "Insert block" })
		.getByRole("option", { name: "Investigate", exact: true })
		.click();
	let composer = page.getByRole("region", { name: "Investigation brief", exact: true });
	await composer.getByRole("textbox", { name: "Investigation brief", exact: true }).fill(brief);
	let [created] = await Promise.all([
		page.waitForResponse(response =>
			response.request().method() === "POST"
			&& response.url().endsWith(`/documents/${room}/experiments`)
		),
		composer.getByRole("button", { name: "Propose investigation", exact: true }).click(),
	]);
	await expect(composer).toHaveCount(0);
	return await created.json() as { id: string };
}

test("the clicker's own agent runs work and publishes evidence that survives disconnect", async ({ baseURL, join, room, seed }) => {
	await seed(`# Investigation\n\n${PASSAGE}\n`);
	let page = await join(person());
	let pairing = await (await fetch(`${baseURL}/api/connector/pairings`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			repository: "octo-org/score",
			commit: "a".repeat(40),
			label: "Ana laptop",
		}),
	})).json();
	await page.goto(pairing.url);
	await expect(page.getByRole("heading", { name: "Connect your local agent", exact: true }))
		.toBeVisible();
	await expect(page.getByText("Connect this checkout of octo-org/score so Chopin can run work"))
		.toBeVisible();
	await expect(page.getByText(pairing.code, { exact: true })).toBeVisible();
	await expect(page.getByRole("combobox")).toHaveCount(0);
	await page.getByRole("button", { name: "Connect", exact: true }).click();
	await expect(page.getByRole("status")).toHaveText("Connected.");
	await expect(page.getByRole("link", { name: "Open octo-org/score", exact: true }))
		.toHaveAttribute("href", "/documents/octo-org/score");
	await expect(page.getByText("a".repeat(8))).toHaveCount(0);
	await page.goto(testChannelPath(room));
	let paired = await (await fetch(`${baseURL}/api/connector/pairings/${pairing.id}/claim`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ secret: pairing.secret }),
	})).json();

	await expect(page.getByRole("button", { name: "Investigations", exact: true })).toHaveCount(0);
	await expect(page.getByRole("dialog", { name: "Investigations", exact: true })).toHaveCount(0);
	await expect(page.getByText("Propose investigation", { exact: true })).toHaveCount(0);
	let experiment = await investigate(page, room, "Compare startup approaches", PASSAGE);
	await expect(content(page).locator(`[data-plan-investigation="${experiment.id}"]`))
		.toHaveCount(1);
	let peer = await join("leo");
	let proposal = card(page, "Compare startup approaches");
	await expect(proposal).toContainText("Ready to run");
	await expect(proposal.getByRole("combobox")).toHaveCount(0);
	// Another person's Run never borrows Ana's agent.
	let peerProposal = card(peer, "Compare startup approaches");
	await peerProposal.getByRole("button", { name: "Run", exact: true }).click();
	await expect(peerProposal).toContainText("Start your local agent to run this:");
	await expect(proposal).toContainText("Ready to run");
	await proposal.getByRole("button", { name: "Run", exact: true }).click();
	await expect(proposal).toContainText("Waiting for your local agent");
	async function tool(name: string, args: unknown, token = paired.token) {
		let response = await fetch(`${baseURL}/connector/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		});
		let body = await response.json();
		expect(body.result?.isError).not.toBe(true);
		return JSON.parse(body.result.content[0].text);
	}
	await expect.poll(async () => (await tool("wait_for_experiment", {})).id).toBe(experiment.id);
	let claim = await tool("claim_experiment", { id: experiment.id });
	await tool("submit_experiment_result", { result: performance }, claim.runToken);
	await tool("complete_experiment", { id: experiment.id, generation: claim.generation });
	await expect(page.getByRole("table", { name: "Median startup time", exact: true })).toBeVisible();
	await expect(page.getByRole("table", { name: "Median startup time", exact: true })).toContainText(
		"183",
	);
	await peer.getByRole("combobox", { name: "Filter Workload", exact: true }).selectOption(
		JSON.stringify("small"),
	);
	await expect(page.getByRole("combobox", { name: "Filter Workload", exact: true })).toHaveValue(
		JSON.stringify("small"),
	);
	await expect(page.getByRole("table", { name: "Median startup time", exact: true })).not
		.toContainText("410");
	await peer.getByRole("button", { name: "Select Cached", exact: true }).click();
	await expect(page.getByRole("button", { name: "Select Cached", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await peer.getByRole("button", { name: "Record decision", exact: true }).click();
	await peer.getByRole("textbox", { name: "Decision conclusion", exact: true }).fill(
		"Use cached startup",
	);
	await peer.getByRole("textbox", { name: "Decision rationale", exact: true }).fill(
		"Lower median in the captured workload",
	);
	await peer.getByRole("button", { name: "Save decision", exact: true }).click();
	await expect(peer.getByRole("heading", { name: "Use cached startup", exact: true }))
		.toBeVisible();
	await peer.getByRole("combobox", { name: "Filter Workload", exact: true }).selectOption(
		JSON.stringify("large"),
	);
	await peer.getByRole("button", { name: "Insert decision evidence in document", exact: true })
		.click();
	await expect(content(page)).toHaveAttribute("contenteditable", "true");
	let saved = page.getByRole("article", { name: "Saved investigation evidence", exact: true });
	await expect(saved).toContainText("Use cached startup");
	await expect(saved.getByRole("table")).toContainText("183");
	await expect(saved.getByRole("table")).not.toContainText("410");
	let second = await investigate(page, room, "Check memory use", PASSAGE);
	let queued = card(page, "Check memory use");
	await queued.getByRole("button", { name: "Run", exact: true }).click();
	await expect(queued.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
	await expect(card(peer, "Check memory use").getByRole("button", { name: "Stop", exact: true }))
		.toHaveCount(0);
	await queued.getByRole("button", { name: "Stop", exact: true }).click();
	await expect(queued).toContainText("Stopped");
	await queued.getByRole("button", { name: "Retry", exact: true }).click();
	// Retry keeps the same investigation and its one card.
	await expect(queued).toHaveCount(1);
	await expect(content(page).locator(`[data-plan-investigation="${second.id}"]`)).toHaveCount(1);
	await expect(queued.getByRole("button", { name: "Run", exact: true })).toBeVisible();
	await queued.getByRole("button", { name: "Remove investigation", exact: true }).click();
	await expect(queued).toHaveCount(0);
	await tool("disconnect_workspace", {});
	await page.reload();

	await expect(
		card(page, "Compare startup approaches").getByRole("table", {
			name: "Median startup time",
			exact: true,
		}),
	).toContainText("410");
});

test("a proposal typed from the slash menu appears inline on a phone", async ({ join, seed, room }) => {
	await seed("# Investigation\n\nCheck before choosing an approach.\n");
	let page = await join(person(), {
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	let created = await investigate(
		page,
		room,
		"Measure startup before choosing a cache",
		"Check before choosing an approach.",
	);
	let proposal = card(page, "Measure startup before choosing a cache");
	await expect(proposal).toContainText("Ready to run");
	await expect(proposal.getByRole("combobox")).toHaveCount(0);
	await proposal.getByRole("button", { name: "Run", exact: true }).click();
	await expect(proposal).toContainText("Start your local agent to run this:");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.reload();
	await expect(content(page).locator(`[data-plan-investigation="${created.id}"]`)).toHaveCount(1);
	await expect(proposal.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
});
