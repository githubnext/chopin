import { chatInput } from "./chat-input";
import { readSource } from "./database";
import {
	CORRECTED_EXPERIMENT,
	CORRECTION,
	COWORKER_FEEDBACK,
	DISAGREEMENT,
	EXPERIMENT,
	HUMAN_NOTE,
	OBSERVATION,
	UNCHANGED,
} from "./harness/fake-document-development";
import { authenticate, content, expect, ready, roomPath, test, written } from "./room";
import type { DocumentDevelopment, Plan } from "../packages/protocol/index";
import type { Page } from "@playwright/test";

function draft(page: Page) {
	return page.getByRole("group", { name: "Document draft updates", exact: true });
}

async function send(page: Page, text: string) {
	let chat = page.getByRole("complementary", { name: "Chat", exact: true });
	await chatInput(chat).fill(text);
	await chat.getByRole("button", { name: "Send message", exact: true }).click();
	await expect(chat).toContainText(text);
}

function record(page: Page) {
	let states: DocumentDevelopment.State[] = [];
	let opens: Plan.Open.Reply[] = [];
	let updates: Plan.Update[] = [];
	page.on("websocket", socket => {
		socket.on("framereceived", ({ payload }) => {
			if (typeof payload !== "string") return;
			let frame = JSON.parse(payload) as { kind: string };
			if (frame.kind === "document-development:state") {
				states.push(frame as DocumentDevelopment.State);
			}
			if (frame.kind === "plan:open") opens.push(frame as Plan.Open.Reply);
			if (frame.kind === "plan:update") updates.push(frame as Plan.Update);
		});
	});
	return { states, opens, updates };
}

async function refuseReaderControl(page: Page, room: string) {
	return page.evaluate(async channel => {
		let url = new URL("/ws", location.href);
		url.protocol = "ws:";
		url.searchParams.set("channel", channel);
		let socket = new WebSocket(url);
		try {
			return await new Promise<{ kind: string; message?: string }>((resolve, reject) => {
				let rid = crypto.randomUUID();
				let timeout = setTimeout(() => reject(new Error("reader control had no reply")), 10_000);
				socket.addEventListener("error", () => reject(new Error("reader socket failed")));
				socket.addEventListener("message", event => {
					let frame = JSON.parse(String(event.data)) as {
						kind: string;
						rid?: string;
						message?: string;
					};
					if (frame.kind === "session:hello") {
						socket.send(JSON.stringify({
							kind: "document-development:control",
							paused: true,
							rid,
							ts: 0,
						}));
					}
					if (frame.rid === rid) {
						clearTimeout(timeout);
						resolve(frame);
					}
				});
			});
		} finally {
			socket.close();
		}
	}, room);
}

// Scripted inference proves the production vertical slice and protection rules, not model taste.
test(
	"ordinary discussion develops provisional prose while human edits remain permanently protected",
	async ({ baseURL, browser, join, page, room, seed }, info) => {
		test.setTimeout(300_000);
		await seed("# Decision discoverability\n\nGoal: help people use decisions.\n");
		let frames = record(page);
		let ana = await join("ana");
		let bo = await join("bo");
		await send(ana, COWORKER_FEEDBACK);
		await send(bo, DISAGREEMENT);
		await expect(content(ana).getByText(OBSERVATION, { exact: true })).toBeVisible({
			timeout: 90_000,
		});
		for (let peer of [ana, bo]) {
			await expect(content(peer)).toContainText(
				"ana suggests onboarding; bo prefers clearer names",
			);
			await expect(content(peer)).toContainText("competing proposals, not a team decision");
			await expect(content(peer).getByText(EXPERIMENT, { exact: true })).toBeVisible();
		}
		await expect.poll(() => frames.states.at(-1)?.generated).toBe(3);
		await written(ana, room, EXPERIMENT);

		// Undo restores the bytes, but must never restore automatic ownership of the passage.
		let observation = content(ana).getByText(OBSERVATION, { exact: true });
		await observation.click();
		await observation.evaluate(element => {
			let range = document.createRange();
			range.selectNodeContents(element);
			range.collapse(false);
			let selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
		});
		await ana.keyboard.insertText(HUMAN_NOTE);
		await written(ana, room, OBSERVATION + HUMAN_NOTE);
		await expect.poll(() => frames.states.at(-1)?.protected).toBe(1);
		await ana.keyboard.press("Meta+z");
		await expect(content(ana).getByText(OBSERVATION, { exact: true })).toBeVisible();
		await expect.poll(() => frames.states.at(-1)?.protected).toBe(1);
		await ana.keyboard.press("Meta+Shift+z");
		await written(ana, room, OBSERVATION + HUMAN_NOTE);
		await ana.reload();
		await ready(ana);
		await expect.poll(() => frames.states.at(-1)?.protected).toBe(1);
		await expect(content(ana)).toContainText(HUMAN_NOTE.trim());

		await send(bo, CORRECTION);
		await expect(content(ana).getByText(CORRECTED_EXPERIMENT, { exact: true })).toBeVisible({
			timeout: 90_000,
		});
		await expect(content(ana)).toContainText(OBSERVATION + HUMAN_NOTE);
		await expect(content(bo)).toContainText(OBSERVATION + HUMAN_NOTE);
		await expect(content(ana)).toContainText("ana suggests onboarding; bo prefers clearer names");
		await expect(content(ana).getByText(EXPERIMENT, { exact: true })).toHaveCount(0);
		await written(ana, room, CORRECTED_EXPERIMENT);
		await expect.poll(() => frames.states.at(-1)?.pending).toBe(false);
		await ana.screenshot({
			path: info.outputPath("document-development-collaboration.png"),
			fullPage: true,
		});

		// A completed no-op may persist its receipt; it must not emit a document update or revision.
		await ana.reload();
		await ready(ana);
		let before = frames.opens.at(-1)!;
		let port = Number(new URL(ana.url()).port);
		let source = await readSource(port, room);
		let updates = frames.updates.length;
		let unchanged = frames.states.filter(state => state.lastOutcome === "unchanged").length;
		await send(ana, UNCHANGED);
		await expect.poll(
			() =>
				frames.states.filter(state => state.lastOutcome === "unchanged" && !state.pending).length,
			{ timeout: 90_000 },
		).toBeGreaterThan(unchanged);
		expect(frames.updates).toHaveLength(updates);
		expect(await readSource(port, room)).toBe(source);
		await ana.reload();
		await ready(ana);
		expect(frames.opens.at(-1)!.revision).toBe(before.revision);
		expect(frames.opens.at(-1)!.seq).toBe(before.seq);
		await expect.poll(() => frames.states.at(-1)?.protected).toBe(1);

		let pause = draft(ana).getByRole("button", { name: "Pause draft updates", exact: true });
		await pause.focus();
		await ana.keyboard.press("Enter");
		await expect(draft(ana).getByRole("status")).toHaveText("Draft updates paused");
		await expect(draft(bo).getByRole("status")).toHaveText("Draft updates paused");
		await ana.reload();
		await ready(ana);
		await expect(draft(ana).getByRole("status")).toHaveText("Draft updates paused");
		let resume = draft(ana).getByRole("button", { name: "Resume draft updates", exact: true });
		await resume.focus();
		await ana.keyboard.press("Enter");
		await expect(draft(bo).getByRole("status")).toHaveText("Provisional draft");
		let readerContext = await browser.newContext({ baseURL });
		try {
			let reader = await readerContext.newPage();
			await authenticate(reader, "readonly", baseURL!);
			await reader.goto(roomPath(room));
			await expect(content(reader)).toContainText(CORRECTED_EXPERIMENT);
			await expect(content(reader)).toHaveAttribute("contenteditable", "false");
			await expect(draft(reader).getByRole("status")).toHaveText("Provisional draft");
			await expect(draft(reader).getByRole("button")).toHaveCount(0);
			let refused = await refuseReaderControl(reader, room);
			expect(refused.kind).toBe("session:error");
			expect(refused.message).toContain("write access");
			await expect(draft(ana).getByRole("status")).toHaveText("Provisional draft");
		} finally {
			await readerContext.close();
		}
	},
);
