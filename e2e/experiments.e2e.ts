import { performance } from "../packages/experiment/src/fixtures";
import { testChannelPath } from "./database";
import { content, expect, test } from "./room";

/** A connection serves every document in its repository, so each pairing test is its own person. */
function person() {
	return `ana-${crypto.randomUUID().slice(0, 8)}`;
}

test("the clicker's own agent runs work and publishes evidence that survives disconnect", async ({ baseURL, join, room, seed }) => {
	await seed("# Investigation\n\nCompare measured startup time.\n");
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
	await page.locator("summary").filter({ hasText: /^Propose investigation$/ }).click();
	await page.getByRole("textbox", { name: "Investigation brief", exact: true }).fill(
		"Compare startup approaches",
	);
	let [created] = await Promise.all([
		page.waitForResponse(response =>
			response.request().method() === "POST"
			&& response.url().endsWith(`/documents/${room}/experiments`)
		),
		page.getByRole("button", { name: "Propose investigation", exact: true }).click(),
	]);
	let experiment = await created.json();
	let peer = await join("leo");
	let proposal = page.getByRole("article", { name: "Compare startup approaches", exact: true });
	await expect(proposal.getByRole("status")).toHaveText("Ready to run");
	await expect(proposal.getByRole("combobox")).toHaveCount(0);
	// Another person's Run never borrows Ana's agent.
	let peerProposal = peer.getByRole("article", { name: "Compare startup approaches", exact: true });
	await peerProposal.getByRole("button", { name: "Run", exact: true }).click();
	await expect(peerProposal).toContainText("Start your local agent to run this:");
	await expect(proposal.getByRole("status")).toHaveText("Ready to run");
	await proposal.getByRole("button", { name: "Run", exact: true }).click();
	await expect(proposal.getByRole("status")).toHaveText("Waiting for your local agent");
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
	let queuedId = crypto.randomUUID();
	let proposed = await page.request.post(`/api/documents/${room}/experiments`, {
		headers: { origin: new URL(page.url()).origin },
		data: { id: queuedId, brief: "Check memory use" },
	});
	expect(proposed.ok(), await proposed.text()).toBe(true);
	let queued = page.getByRole("article", { name: "Check memory use", exact: true });
	await queued.getByRole("button", { name: "Run", exact: true }).click();
	await expect(queued.getByRole("button", { name: "Cancel investigation", exact: true }))
		.toBeVisible();
	await expect(peer.getByRole("button", { name: "Cancel investigation", exact: true })).toHaveCount(
		0,
	);
	await queued.getByRole("button", { name: "Cancel investigation", exact: true }).click();
	await expect(queued.getByRole("status")).toHaveText("Cancelled");
	await queued.getByRole("button", { name: "Propose retry", exact: true }).click();
	await expect(queued).toHaveCount(2);
	await expect(queued.getByRole("button", { name: "Run", exact: true })).toBeVisible();
	await tool("disconnect_workspace", {});
	await page.reload();

	await expect(
		page.getByRole("article", { name: "Compare startup approaches", exact: true }).getByRole(
			"table",
			{
				name: "Median startup time",
				exact: true,
			},
		),
	).toContainText("410");
});

test("an incoming proposal appears inline and recovers from a failed detail load", async ({ join, seed, room }) => {
	await seed("# Investigation\n\nCheck before choosing an approach.\n");
	let page = await join(person(), {
		viewport: { width: 390, height: 844 },
		isMobile: true,
		hasTouch: true,
	});
	let id = crypto.randomUUID();
	await page.route(`**/api/documents/${room}/experiments/${id}`, async route => {
		await route.fulfill({ status: 503, json: { error: "Investigation temporarily unavailable" } });
	}, { times: 1 });
	let response = await page.request.post(`/api/documents/${room}/experiments`, {
		headers: { origin: new URL(page.url()).origin },
		data: { id, brief: "Measure startup before choosing a cache" },
	});
	expect(response.ok(), await response.text()).toBe(true);
	let card = page.getByRole("article", {
		name: "Measure startup before choosing a cache",
		exact: true,
	});
	await expect(card.getByRole("button", { name: "Retry loading", exact: true })).toBeVisible();
	await card.getByRole("button", { name: "Retry loading", exact: true }).click();
	await expect(card.getByRole("status")).toHaveText("Ready to run");
	await expect(card.getByRole("combobox")).toHaveCount(0);
	await card.getByRole("button", { name: "Run", exact: true }).click();
	await expect(card).toContainText("Start your local agent to run this:");
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await page.reload();
	await expect(card.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
});
