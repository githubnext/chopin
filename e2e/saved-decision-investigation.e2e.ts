import { CONNECTOR_PROTOCOL_HEADER } from "../packages/protocol/connector";
import { ulid } from "../packages/dialect/src";
import { CONNECTOR_PROTOCOL } from "../apps/connector/src/version";
import { writtenSeed } from "./decision-deck-fixtures";
import { testChannelPath } from "./database";
import { expect, test } from "./room";

const CONNECTOR = { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL) };
const QUESTION = "Where should onboarding progress live?";

test(
	"saving a decision keeps its running investigation reachable without reopening the answer",
	async ({ baseURL, join, room, seed }, info) => {
		let decision = writtenSeed(QUESTION, undefined, ulid());
		await seed(decision.source, decision.state);
		let page = await join(`ana-${crypto.randomUUID().slice(0, 8)}`);
		let pairing = await (await fetch(`${baseURL}/api/connector/pairings`, {
			method: "POST",
			headers: { "content-type": "application/json", ...CONNECTOR },
			body: JSON.stringify({
				repository: "octo-org/score",
				commit: "a".repeat(40),
				label: "Decision investigation fixture",
			}),
		})).json();
		await page.goto(pairing.url);
		await page.getByRole("button", { name: "Add machine", exact: true }).click();
		await expect(page.getByRole("status").filter({ hasText: "Connected" })).toHaveText("Connected");
		let machine = await (await fetch(`${baseURL}/api/connector/pairings/${pairing.id}/claim`, {
			method: "POST",
			headers: { "content-type": "application/json", ...CONNECTOR },
			body: JSON.stringify({ secret: pairing.secret }),
		})).json();
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
				label: "Decision investigation fixture",
			}),
		})).json();
		let tool = async (name: string, args: unknown) => {
			let response = await fetch(`${baseURL}/connector/mcp`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${paired.token}`,
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
			expect(body.result?.isError, JSON.stringify(body)).not.toBe(true);
			return JSON.parse(body.result.content[0].text);
		};
		try {
			await page.goto(testChannelPath(room));
			let decisions = () =>
				page.getByRole("group", { name: "Document view", exact: true })
					.getByRole("button", { name: /^Decisions/ }).click();
			await decisions();
			let card = page.locator('[data-document-view="decisions"] article')
				.filter({ has: page.getByRole("heading", { name: QUESTION, exact: true }) });
			await card.getByRole("button", { name: "Research", exact: true }).click();
			let menu = page.getByRole("dialog", { name: "Research", exact: true });
			let investigate = menu.getByRole("button", { name: /^Investigate the codebase/ });
			await investigate.click();
			let controls = await investigate.getAttribute("aria-controls");
			await page.locator(`[id="${controls}"]`)
				.getByRole("textbox", { name: "Details (optional)", exact: true })
				.fill("Measure onboarding storage in the local codebase");
			await menu.getByRole("button", { name: "Start investigation", exact: true }).click();
			let work: { id?: string } = {};
			await expect.poll(async () => {
				work = await tool("wait_for_experiment", {});
				return work.id;
			}).toBeTruthy();
			let claim = await tool("claim_experiment", { id: work.id });
			expect(claim.generation).toBe(1);
			await card.getByRole("textbox", { name: "Answer", exact: true }).fill(
				"Infer it from documents.",
			);
			await card.getByRole("button", { name: "Save", exact: true }).click();
			await expect(card.getByRole("button", { name: "Reopen", exact: true })).toBeVisible();
			await page.reload();
			await decisions();
			await card.getByRole("button", { name: "Expand decision", exact: true }).click();
			let full = page.locator("[data-question-page]");
			await expect(full.getByRole("heading", { name: QUESTION, exact: true })).toBeVisible();
			await expect(full.getByRole("textbox", { name: "Answer", exact: true })).toBeDisabled();
			await expect(full.getByRole("textbox", { name: "Answer", exact: true }))
				.toHaveValue("Infer it from documents.");
			let investigation = full.getByRole("article", { name: "Investigation", exact: true });
			await expect(investigation).toHaveAttribute("data-investigation-state", "running");
			await expect(investigation.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
			await page.screenshot({
				path: info.outputPath("saved-decision-investigation.png"),
				animations: "disabled",
			});
			await investigation.getByRole("button", { name: "Stop", exact: true }).click();
			await expect(investigation).toHaveAttribute("data-investigation-state", "cancelled");
			await expect(full.getByRole("textbox", { name: "Answer", exact: true }))
				.toHaveValue("Infer it from documents.");
			await expect(investigation.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
		} finally {
			await tool("disconnect_workspace", {});
		}
	},
);
