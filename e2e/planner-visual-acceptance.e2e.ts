import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { chatInput, fillChat } from "./chat-input";
import { createChannel, readSource, seedChannel, testChannelPath } from "./database";
import { APP_PORT, loadAcceptance, materialize, MCP_PORT } from "./planner-visual-acceptance";
import { authenticate, ready } from "./room";

import type { Chat, Question } from "../packages/protocol/index";

let acceptance = process.env.E2E_PLANNER_VISUAL_ACCEPTANCE === "1"
	? loadAcceptance()
	: undefined;

async function localRecords(path: string): Promise<unknown[]> {
	let response = await fetch(`http://127.0.0.1:${MCP_PORT}/${path}`);
	if (!response.ok) throw new Error(`Local acceptance record ${path} is unavailable`);
	return await response.json() as unknown[];
}

async function save(path: string, value: unknown): Promise<void> {
	await writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

async function stopped(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

function handshook(calls: unknown[]): boolean {
	let records = calls.filter((call): call is {
		method: string;
		hasBearer: boolean;
		readonly: string | null;
		toolsets: string | null;
	} => typeof call === "object" && call !== null && "method" in call);
	return records.some(call => call.method === "initialize" && call.hasBearer)
		&& records.some(call =>
			call.method === "tools/list" && call.hasBearer
			&& call.readonly === "true" && call.toolsets === "pull_requests"
		);
}

function optionName(label: string): RegExp {
	return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
}

if (!acceptance) {
	test.skip("Real Planner visual acceptance is opt-in", () => {});
}

for (let frozen of acceptance?.cases ?? []) {
	test(`real Planner: ${frozen.caseId}`, async ({ baseURL, page }) => {
		let run = acceptance!;
		let visualRouting = run.configuration.phase === "jev-candidate";
		let stopPath = join(run.outputRoot, "jev-stop.json");
		if (visualRouting && await stopped(stopPath)) {
			throw new Error("Earlier Jev acceptance case stopped the bounded run");
		}
		let item = await materialize(frozen);
		let directory = join(run.outputRoot, item.id);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		let channelId = crypto.randomUUID();
		let startedAt = new Date().toISOString();
		await writeFile(
			join(directory, "reservation.json"),
			JSON.stringify(
				{
					caseId: item.id,
					runId: run.runId,
					channelId,
					startedAt,
					model: process.env.E2E_VISUAL_MODEL,
					harness: "copilot-sdk",
					configurationSha256: run.configSha256,
					datasetManifestSha256: run.configuration.datasetManifestSha256,
					cohortSha256: run.configuration.cohortSha256,
					loaderId: item.loaderId,
					checkpointId: item.checkpointId,
					loaderOutputSha256: item.loaderOutputSha256,
					sourceSha256: item.sourceSha256,
					promptSha256: item.promptSha256,
					origin: item.origin,
					sourceCluster: item.sourceCluster,
					cutoff: item.cutoff,
				},
				null,
				2,
			) + "\n",
			{ flag: "wx", mode: 0o600 },
		);
		await writeFile(join(directory, "prompt.txt"), item.prompt, { mode: 0o600 });
		await createChannel(APP_PORT, channelId);
		await seedChannel(APP_PORT, channelId, item.source);
		await writeFile(join(directory, "source.before.mdx"), item.source, { mode: 0o600 });

		let frames: Array<{ at: number; frame: Chat.Outgoing }> = [];
		let asked: Question.Asked[] = [];
		await page.routeWebSocket("**/ws?**", route => {
			let server = route.connectToServer();
			route.onMessage(message => server.send(message));
			server.onMessage(message => {
				if (typeof message === "string") {
					let frame = JSON.parse(message) as Chat.Outgoing | Question.Asked;
					if (frame.kind === "question:asked") asked.push(frame);
					if (frame.kind.startsWith("chat:")) {
						frames.push({ at: Date.now(), frame: frame as Chat.Outgoing });
					}
				}
				route.send(message);
			});
		});
		let failure: unknown;
		let sentAt = 0;
		let completedAt = 0;
		let sourceAfter = "";
		let rendered: unknown;
		let history: Chat.History | undefined;
		let mcpBefore: unknown[] = [];
		let blockedBefore: unknown[] = [];
		let answeredControl = false;
		try {
			mcpBefore = await localRecords("__calls__");
			blockedBefore = await localRecords("__blocked__");
			await authenticate(page, "ana", baseURL!);
			await page.goto(testChannelPath(channelId));
			await ready(page);
			let chat = page.getByRole("complementary", { name: "Chat", includeHidden: true });
			await fillChat(chatInput(chat), `@chopin ${item.prompt}`);
			sentAt = Date.now();
			await chat.getByRole("button", { name: "Send message" }).click();
			await expect.poll(
				() =>
					frames.some(row => row.at >= sentAt && row.frame.kind === "chat:state" && row.frame.busy),
				{ timeout: 30_000 },
			).toBe(true);
			let busyIndex = frames.findIndex(row =>
				row.at >= sentAt
				&& row.frame.kind === "chat:state" && row.frame.busy
			);
			let idle = () =>
				frames.slice(busyIndex + 1).some(row => row.frame.kind === "chat:state" && !row.frame.busy);
			await expect.poll(() => idle() || asked.length > 0, { timeout: 300_000 })
				.toBe(true);
			if (asked.length > 0) {
				await save(join(directory, "question-asked.json"), asked);
				if (visualRouting) {
					if (!idle()) {
						await chat.getByRole("button", { name: "Stop Chopin" }).click();
						await expect.poll(idle, { timeout: 30_000 }).toBe(true);
					}
					throw new Error("Unexpected ask: Jev-three run does not answer or start another turn");
				}
				let decision = asked[0]!;
				let question = decision.definition.questions[0];
				let answer = process.env.E2E_VISUAL_QUESTION_ANSWER?.trim();
				let option = question?.options.find(candidate => candidate.label === answer);
				if (asked.length !== 1 || decision.definition.questions.length !== 1 || !option) {
					await chat.getByRole("button", { name: "Stop Chopin" }).click();
					await expect.poll(idle, { timeout: 30_000 }).toBe(true);
					throw new Error("Question needs one matching E2E_VISUAL_QUESTION_ANSWER; turn stopped");
				}
				await page.getByRole("button", { name: /^Decisions/ }).click();
				let card = page.locator(
					`[data-document-view="decisions"] article[data-plan-sidecar-questionnaire="${decision.id}"]`,
				);
				await expect(card).toBeVisible();
				await card.getByRole("radio", { name: optionName(option.label) }).check({
					timeout: 20_000,
				});
				await card.getByRole("button", { name: "Save", exact: true }).click();
				answeredControl = true;
				await page.getByRole("button", { name: "Document", exact: true }).click();
			}
			await expect.poll(idle, { timeout: 300_000 }).toBe(true);
			if (visualRouting && await stopped(stopPath)) {
				throw new Error("Jev request failed or exceeded the bounded run cap");
			}
			completedAt = Date.now();
			sourceAfter = await readSource(APP_PORT, channelId);
			await writeFile(join(directory, "source.after.mdx"), sourceAfter, { mode: 0o600 });
			await page.reload();
			await ready(page);
			await expect.poll(() =>
				frames.some(row =>
					row.frame.kind === "chat:history"
					&& row.at >= completedAt
				)
			).toBe(true);
			history = frames.findLast(row => row.frame.kind === "chat:history")
				?.frame as Chat.History | undefined;
			let reopenedSource = await readSource(APP_PORT, channelId);
			await writeFile(join(directory, "source.reopened.mdx"), reopenedSource, {
				mode: 0o600,
			});
			expect(reopenedSource).toBe(sourceAfter);
			if (/^```seecode\s*$/m.test(sourceAfter)) {
				let preview = page.getByRole("textbox", { name: "editable markdown" })
					.getByRole("region", { name: "Diagram preview", exact: true });
				await expect(preview.first().locator("svg")).toBeVisible({ timeout: 20_000 });
			}
			if (answeredControl) {
				await page.getByRole("button", { name: /^Decisions/ }).click();
				await page.getByRole("button", { name: /^1 resolved$/ }).click();
				let card = page.locator(
					`[data-document-view="decisions"] article[data-plan-sidecar-questionnaire="${
						asked[0]!.id
					}"]`,
				);
				await expect(card).toBeVisible();
				for (let option of asked[0]!.definition.questions[0]!.options) {
					await expect(card).toContainText(option.label);
				}
				await save(join(directory, "reopened-question.json"), {
					id: asked[0]!.id,
					options: asked[0]!.definition.questions[0]!.options.map(option => option.label),
					text: await card.textContent(),
				});
				await page.screenshot({
					path: join(directory, "reopened-decision.png"),
					fullPage: true,
					animations: "disabled",
				});
				await page.getByRole("button", { name: "Document", exact: true }).click();
			}
			rendered = await page.evaluate(() => {
				let editor = document.querySelector('[data-document-view="plan"]');
				return {
					diagrams: [...(editor?.querySelectorAll(".ch-diagram svg[data-sc-type]") ?? [])]
						.map(svg => ({
							type: svg.getAttribute("data-sc-type"),
							title: svg.querySelector("title")?.textContent ?? "",
							labels: [...svg.querySelectorAll("text")].map(label => label.textContent),
						})),
					questionnaires: editor?.querySelectorAll("article[data-plan-sidecar-questionnaire]")
						.length ?? 0,
					tables: editor?.querySelectorAll("table").length ?? 0,
					callouts: editor?.querySelectorAll('[data-plan-chrome="callout"]').length ?? 0,
					tabs: editor?.querySelectorAll('[data-plan-chrome="tabs"]').length ?? 0,
					errors: [...(editor?.querySelectorAll("[data-plan-error]") ?? [])]
						.map(error => error.textContent),
				};
			});
			await page.screenshot({
				path: join(directory, "reopened.png"),
				fullPage: true,
				animations: "disabled",
			});
			await page.locator("[data-plan-scroll]").evaluate(element => {
				element.scrollTop = element.scrollHeight;
			});
			await page.screenshot({
				path: join(directory, "reopened-bottom.png"),
				fullPage: true,
				animations: "disabled",
			});
		} catch (error) {
			failure = error;
		} finally {
			if (!sourceAfter) {
				sourceAfter = await readSource(APP_PORT, channelId).catch(() => "");
				if (sourceAfter) {
					await writeFile(join(directory, "source.after.mdx"), sourceAfter, { mode: 0o600 });
				}
			}
			if (failure) {
				if (visualRouting) {
					await writeFile(
						stopPath,
						JSON.stringify({
							reason: "case-incomplete",
							caseId: item.id,
							at: new Date().toISOString(),
						}) + "\n",
						{ flag: "wx", mode: 0o600 },
					).catch(error => {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					});
				}
				await page.screenshot({ path: join(directory, "failure.png"), fullPage: true })
					.catch(() => {});
			}
			let mcp = await localRecords("__calls__").catch(() => []);
			let caseMcp = mcp.slice(mcpBefore.length);
			let blocked = await localRecords("__blocked__").catch(() => []);
			let toolFrames = frames.filter(row => row.frame.kind === "chat:tool");
			let agentEntries = history?.entries.filter(entry => entry.author.kind === "agent") ?? [];
			await save(join(directory, "selection.json"), {
				caseId: item.id,
				questionAsked: asked.map(frame => ({
					id: frame.id,
					options: frame.definition.questions.flatMap(question =>
						question.options.map(option => option.label)
					),
				})),
				answeredControl,
				diagramFences: (sourceAfter.match(/^```seecode\s*$/gm) ?? []).length,
				markdownTableRows: (sourceAfter.match(/^\|.*\|\s*$/gm) ?? []).length,
				calloutComponents: (sourceAfter.match(/<Callout\b/g) ?? []).length,
				tabComponents: (sourceAfter.match(/<Tabs\b/g) ?? []).length,
				questionnaireProjections: (sourceAfter.match(/<Questionnaire\b/g) ?? []).length,
				sourceChanged: !!sourceAfter && sourceAfter !== item.source,
				agentText: agentEntries.map(entry => entry.text),
				tools: toolFrames.map(row => ({
					name: (row.frame as Chat.Tool).activity.name,
					status: (row.frame as Chat.Tool).activity.status,
				})),
			});
			await save(join(directory, "tool-trace.json"), toolFrames);
			await save(join(directory, "chat-frames.json"), frames);
			await save(join(directory, "mcp-calls.json"), caseMcp);
			await save(
				join(directory, "blocked-source-requests.json"),
				blocked.slice(blockedBefore.length),
			);
			await save(join(directory, "reopen-render.json"), rendered ?? null);
			await save(join(directory, "run.json"), {
				caseId: item.id,
				channelId,
				runId: run.runId,
				startedAt,
				completedAt: completedAt ? new Date(completedAt).toISOString() : null,
				latencyMs: completedAt && sentAt ? completedAt - sentAt : null,
				usage: "Not exposed by the production Chat wire",
				mcpHandshakeObserved: handshook(caseMcp),
				failure: failure ? "Acceptance run did not complete; inspect Playwright output" : null,
			});
		}
		if (failure) throw failure;
		let handshake = handshook((await localRecords("__calls__")).slice(mcpBefore.length));
		if (visualRouting && !handshake) {
			await writeFile(
				stopPath,
				JSON.stringify({
					reason: "mcp-handshake-missing",
					caseId: item.id,
					at: new Date().toISOString(),
				}) + "\n",
				{ flag: "wx", mode: 0o600 },
			);
		}
		expect(handshake).toBe(true);
	});
}
