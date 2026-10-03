import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
	navigationProviderBinding,
	observeRoomSource,
	roomSourceBinding,
} from "./room-source.fixture";
import type { Page } from "@playwright/test";

let script: string, stylesheet: string;
export async function prepareRoomSource(): Promise<void> {
	let roomPath = fileURLToPath(new URL("../../apps/web/src/room-workspace.tsx", import.meta.url));
	let source = await Bun.file(roomPath).text();
	let binding = roomSourceBinding;
	let marker = "\tif (deleted) {";
	expect(source.split(marker)).toHaveLength(2);
	let result = await Bun.build({
		entrypoints: [roomPath],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "real-room-source-probe",
			setup(build) {
				build.onLoad(
					{ filter: /\/room-workspace\.tsx$/ },
					() => ({
						loader: "tsx",
						contents: source.replace(marker, observeRoomSource + marker) + binding,
					}),
				);
				build.onLoad(
					{ filter: /\/navigation-shell\.tsx$/ },
					async args => ({
						loader: "tsx",
						contents: await Bun.file(args.path).text() + navigationProviderBinding,
					}),
				);
			},
		}],
	});
	expect(result.success, JSON.stringify(result.logs)).toBe(true);
	let scripts = result.outputs.filter(output => output.path.endsWith(".js"));
	let styles = result.outputs.filter(output => output.path.endsWith(".css"));
	expect(scripts).toHaveLength(1);
	expect(styles).toHaveLength(1);
	script = await scripts[0]!.text();
	stylesheet = await styles[0]!.text();
}
let source = {
	messageId: "m1",
	author: { kind: "member", handle: "ana" },
	role: "reason",
	quote: "pilot",
	start: 0,
	end: 5,
};
export let meta = {
	status: "open",
	origin: "conversation",
	threadId: "thread-1",
	history: [],
	optionOrigins: {},
};
export let thread = {
	id: "thread-1",
	question: "Choose rollout",
	questionSources: [],
	questionAuthoring: "quoted",
	status: "exploring",
	contributions: [{
		id: "reason-1",
		kind: "reason",
		text: "pilot",
		sources: [source],
		actor: { kind: "classifier" },
		authoring: "quoted",
		targetId: "thread-1",
	}],
	stances: [],
	stanceHistory: [],
	decisionHistory: [],
	candidates: [],
	questionnaireId: "card-1",
	version: 1,
};
export async function load(page: Page) {
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.route(
		"**/*",
		route =>
			route.request().url() === "https://room-source.invalid/"
				&& route.request().isNavigationRequest()
				? route.fulfill({
					contentType: "text/html",
					body: '<main><div id="fixture"></div><div id="evidence-probe"></div></main>',
				})
				: route.abort(),
	);
	await page.goto("https://room-source.invalid/");
	await page.clock.install();
	await page.addStyleTag({ content: stylesheet });
	await page.addStyleTag({
		content:
			"body{margin:0}#fixture{height:800px;width:1200px} [data-chat-stack]{display:flex;flex-direction:column;gap:16px}#evidence-probe{position:fixed;top:10px;right:10px;z-index:100;background:white;width:320px}",
	});
	await page.addScriptTag({ content: script });
	await page.evaluate(() => window.roomSourceProbe.mount());
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.snapshot().room)).toBe(
		"room-a",
	);
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.sockets.length)).toBe(1);
	await page.evaluate(() =>
		window.roomSourceProbe.receive({
			kind: "chat:history",
			entries: [{ id: "m1", text: "pilot", author: { kind: "member", handle: "ana" }, ts: 1 }, {
				id: "m2",
				text: "pilot",
				author: { kind: "member", handle: "ana" },
				ts: 2,
			}],
			queued: [],
			busy: false,
			ts: 1,
		})
	);
	await expect(page.locator('[data-chat-message-id="m1"]')).toHaveCount(1);
	expect(errors).toEqual([]);
	return errors;
}
export async function select(page: Page, id: string) {
	await page.evaluate(id => window.roomSourceProbe.showSource(id), id);
	await expect.poll(() =>
		page.evaluate(() => window.roomSourceProbe.snapshot().destination?.source.messageId)
	).toBe(id);
	await expect(page.locator(`[data-chat-message-id="${id}"]`)).toHaveAttribute(
		"data-source-exact",
		"true",
	);
}
