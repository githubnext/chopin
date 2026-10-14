import { performance } from "../packages/experiment/src/fixtures";
import { CONNECTOR_PROTOCOL_HEADER } from "../packages/protocol/connector";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { testChannelPath } from "./database";
import { content, expect, test } from "./room";

import type { Page } from "@playwright/test";

const CHART_MODULE = /\/assets\/diagram-[^/]+\.js$/;
const RENDER_MODULE = /\/assets\/render-[^/]+\.js$/;

/** What the current connector sends with each request. */
const CONNECTOR = { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL) };

/** A connection serves every document in its repository, so each pairing test is its own person. */
function person() {
	return `ana-${crypto.randomUUID().slice(0, 8)}`;
}

const PASSAGE = "Compare measured startup time.";
const FOLLOW_UP = "Then check memory use.";

test("a plain document does not request the chart renderer", async ({ join, page, seed }) => {
	await seed("# Plain document\n\nThere is no chart here.\n");
	let charts: string[] = [];
	page.on("request", request => {
		if (CHART_MODULE.test(new URL(request.url()).pathname)) charts.push(request.url());
	});
	await join(person());
	expect(charts).toEqual([]);
});

/** The investigation card whose brief this is. */
function card(page: Page, brief: string) {
	return page.getByRole("article", { name: "Investigation", exact: true }).filter({
		hasText: brief,
	});
}

/** Open the child document a completed investigation published, from its inline card. */
async function openChild(page: Page) {
	await card(page, "Startup comparison")
		// Other tests publish the same fixture into this repository, so its title may be numbered.
		.getByRole("button", { name: /^Open Startup comparison/ })
		// Recorded decisions sit above the card-wide control, so open from its status row.
		.click({ position: { x: 16, y: 16 } });
	let child = page.getByRole("region", { name: /^Child document: Startup comparison/ });
	let provenance = child.locator("[data-child-provenance]");
	await expect(provenance).toContainText("Investigation from Investigation");
	await expect(provenance).toContainText("1 view");
	await expect(child.getByRole("heading", { name: "Startup comparison", exact: true }))
		.toBeVisible();
	return child;
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
	// Two people open the published child document as well as running the work.
	test.slow();
	await seed(`# Investigation\n\n${PASSAGE}\n\n${FOLLOW_UP}\n`);
	let page = await join(person());
	let pairing = await (await fetch(`${baseURL}/api/connector/pairings`, {
		method: "POST",
		headers: { "content-type": "application/json", ...CONNECTOR },
		body: JSON.stringify({
			repository: "octo-org/score",
			commit: "a".repeat(40),
			label: "Ana laptop",
		}),
	})).json();
	await page.goto(pairing.url);
	await expect(page.getByRole("heading", { name: "Connect this machine?", exact: true }))
		.toBeVisible();
	await expect(page.getByText("Connect this checkout of octo-org/score so Chopin can run work"))
		.toBeVisible();
	await expect(page.getByText(pairing.code, { exact: true })).toBeVisible();
	await expect(page.getByRole("combobox")).toHaveCount(0);
	await page.getByRole("button", { name: "Connect", exact: true }).click();
	// The page sits inside the navigation, which has live regions of its own.
	await expect(page.getByRole("status").filter({ hasText: "Connected" })).toHaveText("Connected");
	await expect(page.getByRole("link", { name: "Open octo-org/score", exact: true }))
		.toHaveAttribute("href", "/documents/octo-org/score");
	await expect(page.getByText("a".repeat(8))).toHaveCount(0);
	await page.goto(testChannelPath(room));
	let machine = await (await fetch(`${baseURL}/api/connector/pairings/${pairing.id}/claim`, {
		method: "POST",
		headers: { "content-type": "application/json", ...CONNECTOR },
		body: JSON.stringify({ secret: pairing.secret }),
	})).json();
	// The paired machine connects its checkout, as `chopin connect` does.
	let paired = await (await fetch(`${baseURL}/api/connector/connections`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${machine.token}`,
			...CONNECTOR,
		},
		body: JSON.stringify({
			repository: "octo-org/score",
			commit: "a".repeat(40),
			label: "Ana laptop",
		}),
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
	await expect(peerProposal).toContainText("Your local agent isn’t connected.");
	await expect(proposal).toContainText("Ready to run");
	await proposal.getByRole("button", { name: "Run", exact: true }).click();
	await expect(proposal).toContainText("Waiting for your local agent");
	async function tool(name: string, args: unknown, token = paired.token) {
		let response = await fetch(`${baseURL}/connector/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				...CONNECTOR,
			},
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
	let result = structuredClone(performance);
	result.datasets[0]!.rows.push(...Array.from({ length: 9 }, (_, index) => ({
		key: `workload-${index + 1}`,
		values: {
			approach: `Workload ${index + 1}`,
			workload: "large",
			milliseconds: 160 + index,
		},
	})));
	await tool("submit_experiment_result", { result }, claim.runToken);
	await tool("complete_experiment", { id: experiment.id, generation: claim.generation });
	// The result is published as a child document; the inline card only links to it.
	let ready = card(page, "Startup comparison");
	await expect(ready).toHaveAttribute("data-investigation-ready", "");
	await expect(ready).toContainText("Caching reduced median startup time");
	await expect(ready.getByRole("table")).toHaveCount(0);
	let releaseChart!: () => void;
	let heldChart = new Promise<void>(resolve => {
		releaseChart = resolve;
	});
	await page.route(CHART_MODULE, async route => {
		await heldChart;
		await route.continue();
	});
	let child = await openChild(page);
	await expect(child.getByText("Loading chart…", { exact: true })).toBeVisible();
	let table = child.getByRole("table", { name: "Median startup time", exact: true });
	await expect(table).toContainText("183");
	let loadingHeight = await child.getByText("Loading chart…", { exact: true })
		.evaluate(element => (element as HTMLElement).offsetHeight);
	await child.getByRole("combobox", { name: "Filter Workload", exact: true }).selectOption(
		JSON.stringify("small"),
	);
	await expect(table).not.toContainText("410");
	await child.getByRole("button", { name: "Select Cached", exact: true }).click();
	await expect(child.getByRole("button", { name: "Select Cached", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await child.getByRole("combobox", { name: "Filter Workload", exact: true }).selectOption("all");
	releaseChart();
	await expect(child.locator('svg[data-sc-type="bar"]')).toBeVisible();
	let renderedHeight = await child.locator("figure.ch-diagram").first()
		.evaluate(element => (element as HTMLElement).offsetHeight);
	expect(Math.abs(renderedHeight - loadingHeight)).toBeLessThan(40);
	await child.getByRole("combobox", { name: "Filter Workload", exact: true }).selectOption(
		JSON.stringify("small"),
	);
	await page.unroute(CHART_MODULE);
	let releasePeerChart!: () => void;
	let heldPeerChart = new Promise<void>(resolve => {
		releasePeerChart = resolve;
	});
	await peer.route(CHART_MODULE, async route => {
		await heldPeerChart;
		await route.continue();
	});
	let peerChild = await openChild(peer);
	await peerChild.getByRole("combobox", { name: "Filter Workload", exact: true }).selectOption(
		JSON.stringify("small"),
	);
	let peerTable = peerChild.getByRole("table", { name: "Median startup time", exact: true });
	await expect(peerChild.getByText("Loading chart…", { exact: true })).toBeVisible();
	let peerLoadingHeight = await peerChild.getByText("Loading chart…", { exact: true })
		.evaluate(element => (element as HTMLElement).offsetHeight);
	releasePeerChart();
	await expect(peerChild.locator('svg[data-sc-type="bar"]')).toBeVisible();
	let peerRenderedHeight = await peerChild.locator("figure.ch-diagram").first()
		.evaluate(element => (element as HTMLElement).offsetHeight);
	expect(Math.abs(peerRenderedHeight - peerLoadingHeight)).toBeLessThan(40);
	await expect(peerTable).toContainText("183");
	await peer.unroute(CHART_MODULE);
	let narrow = await join("narrow", { viewport: { width: 620, height: 900 } });
	let releaseNarrowChart!: () => void;
	let heldNarrowChart = new Promise<void>(resolve => {
		releaseNarrowChart = resolve;
	});
	await narrow.route(CHART_MODULE, async route => {
		await heldNarrowChart;
		await route.continue();
	});
	let narrowChild = await openChild(narrow);
	let narrowTable = narrowChild.getByRole("table", { name: "Median startup time", exact: true });
	await expect(narrowChild.getByText("Loading chart…", { exact: true })).toBeVisible();
	let narrowLoadingHeight = await narrowChild.getByText("Loading chart…", { exact: true })
		.evaluate(element => (element as HTMLElement).offsetHeight);
	releaseNarrowChart();
	await expect(narrowChild.locator('svg[data-sc-type="bar"]')).toBeVisible();
	let narrowRenderedHeight = await narrowChild.locator("figure.ch-diagram").first()
		.evaluate(element => (element as HTMLElement).offsetHeight);
	expect(Math.abs(narrowRenderedHeight - narrowLoadingHeight)).toBeLessThan(40);
	await expect(narrowTable).toContainText("183");
	await narrow.unroute(CHART_MODULE);
	await expect(child.getByRole("combobox", { name: "Filter Workload", exact: true })).toHaveValue(
		JSON.stringify("small"),
	);
	await expect(table).not.toContainText("410");
	await peerChild.getByRole("button", { name: "Select Cached", exact: true }).click();
	await expect(child.getByRole("button", { name: "Select Cached", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await peerChild.getByRole("button", { name: "Record decision", exact: true }).click();
	await peerChild.getByRole("textbox", { name: "Decision conclusion", exact: true }).fill(
		"Use cached startup",
	);
	await peerChild.getByRole("textbox", { name: "Decision rationale", exact: true }).fill(
		"Lower median in the captured workload",
	);
	await peerChild.getByRole("button", { name: "Save decision", exact: true }).click();
	await expect.poll(async () =>
		(await (await peer.request.get(`/api/documents/${room}/experiments/${experiment.id}`)).json())
			.decisions.map((decision: { conclusion: string }) => decision.conclusion)
	).toEqual(["Use cached startup"]);
	await peerChild.getByRole("combobox", { name: "Filter Workload", exact: true }).selectOption(
		JSON.stringify("large"),
	);
	await expect(table).toContainText("410");
	let failed = await join("casey");
	let renderAttempts = 0;
	await failed.route(RENDER_MODULE, route => {
		renderAttempts++;
		return renderAttempts === 1 ? route.abort("failed") : route.continue();
	});
	await failed.reload();
	let failedChild = await openChild(failed);
	await expect(failedChild.getByRole("alert").filter({ hasText: "Chart could not load." }))
		.toBeVisible();
	await expect(failedChild.getByRole("table", { name: "Median startup time", exact: true }))
		.toContainText("410");
	await failedChild.getByRole("combobox", { name: "Filter Workload", exact: true }).selectOption(
		JSON.stringify("small"),
	);
	await failedChild.getByRole("button", { name: "Select Cached", exact: true }).click();
	await failedChild.getByRole("button", { name: "Reload page", exact: true }).click();
	await expect(failedChild.locator('svg[data-sc-type="bar"]')).toBeVisible();
	await expect(failedChild.getByRole("combobox", { name: "Filter Workload", exact: true }))
		.toHaveValue(JSON.stringify("small"));
	await expect(failedChild.getByRole("button", { name: "Select Cached", exact: true }))
		.toHaveAttribute("aria-pressed", "true");
	expect(renderAttempts).toBe(2);
	await failedChild.getByRole("combobox", { name: "Filter Workload", exact: true }).selectOption(
		JSON.stringify("large"),
	);
	await page.goto(testChannelPath(room));
	let second = await investigate(page, room, "Check memory use", FOLLOW_UP);
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
	await expect((await openChild(page)).getByRole("table", {
		name: "Median startup time",
		exact: true,
	})).toContainText("410");
});

test("a proposal typed from the slash menu appears inline on a phone", async ({ join, seed, room }) => {
	await seed("# Investigation\n\nCheck before choosing an approach.\n");
	let page = await join(person(), {
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	// A phone opens the document for reading; writing starts from the edit toggle.
	await page.getByRole("button", { name: "Edit document", exact: true }).tap();
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
	await expect(proposal).toContainText(
		"Your local agent isn’t connected. Run this in your project folder, then press Run again.",
	);
	await expect(proposal.locator("code")).toHaveText(
		/curl -fsSL http:\/\/\S+\/connector\.js .* bun --no-env-file --config=\/dev\/null ~\/\.chopin\/connector\.js connect \. /,
	);
	await expect(proposal.getByRole("link", { name: "Trouble connecting?", exact: true }))
		.toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.reload();
	await expect(content(page).locator(`[data-plan-investigation="${created.id}"]`)).toHaveCount(1);
	await expect(proposal.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
});
