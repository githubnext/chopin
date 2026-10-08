import { performance } from "../packages/experiment/src/fixtures";
import { expect, test } from "./room";

test("owner pairs a workspace and publishes evidence that survives disconnect", async ({ baseURL, join, room, seed }) => {
	await seed("# Investigation\n\nCompare measured startup time.\n");
	let page = await join("ana");
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
	await page.getByRole("combobox", { name: "Document", exact: true }).selectOption(room);
	await page.getByRole("button", { name: "Connect", exact: true }).click();
	await page.getByRole("link", { name: "Open document", exact: true }).click();
	let paired = await (await fetch(`${baseURL}/api/connector/pairings/${pairing.id}/claim`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ secret: pairing.secret }),
	})).json();
	await page.getByRole("button", { name: "Investigations", exact: true }).click();
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
	await page.getByRole("button", { name: "Run on my workspace", exact: true }).click();
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
	let peer = await join("leo");
	await peer.getByRole("button", { name: "Investigations", exact: true }).click();
	await peer.getByRole("combobox", { name: "Investigation", exact: true }).selectOption(
		experiment.id,
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
	await page.getByRole("button", { name: "Close investigations", exact: true }).click();
	let saved = page.getByRole("article", { name: "Saved investigation evidence", exact: true });
	await expect(saved).toContainText("Use cached startup");
	await expect(saved.getByRole("table")).toContainText("183");
	await expect(saved.getByRole("table")).not.toContainText("410");
	await tool("disconnect_workspace", {});
	await page.reload();
	await page.getByRole("button", { name: "Investigations", exact: true }).click();
	await page.getByRole("combobox", { name: "Investigation", exact: true }).selectOption(
		experiment.id,
	);
	await expect(
		page.getByRole("dialog", { name: "Investigations" }).getByRole("table", {
			name: "Median startup time",
			exact: true,
		}),
	).toContainText("410");
});
