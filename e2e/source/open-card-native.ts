import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { navigationProviderBinding, observeRoomSource } from "./room-source.fixture";
import { observeOpenCard, openCardBinding } from "./open-card.fixture";
import type { Page } from "@playwright/test";

let script: string, stylesheet: string;
let pageErrors = new WeakMap<Page, string[]>();
export async function prepareOpenCard() {
	let entry = fileURLToPath(new URL("../../apps/web/src/room-workspace.tsx", import.meta.url));
	let source = await Bun.file(entry).text();
	let editorRoot = fileURLToPath(new URL("../../packages/editor/", import.meta.url));
	let marker = "\tif (deleted) {";
	expect(source.split(marker)).toHaveLength(2);
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "actual-open-card-room-binding",
			setup(build) {
				// Resolve auxiliary imports using their real browser exports, not Bun's node conditions.
				build.onResolve(
					{ filter: /^(?:@lexical\/react\/|@mdxeditor\/gurx$|lexical$)/ },
					async args => {
						if (args.importer !== entry) return;
						if (args.path === "@mdxeditor/gurx") {
							return { path: Bun.resolveSync(args.path, editorRoot) };
						}
						let name = args.path === "lexical" ? "lexical" : "@lexical/react";
						let directory = editorRoot + "node_modules/" + name + "/";
						let manifest = await Bun.file(directory + "package.json").json();
						let key = args.path === name ? "." : "." + args.path.slice(name.length);
						let browser = manifest.exports[key].import.default;
						expect(typeof browser).toBe("string");
						return { path: directory + browser };
					},
				);
				build.onLoad(
					{ filter: /\/room-workspace\.tsx$/ },
					() => ({
						loader: "tsx",
						contents: source.replace(marker, observeRoomSource + observeOpenCard + marker)
							+ openCardBinding,
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
	let outputs = result.outputs.filter(output => output.path.endsWith(".js"));
	expect(outputs).toHaveLength(1);
	script = await outputs[0]!.text();
	let assets = fileURLToPath(new URL("../../apps/web/dist/assets/", import.meta.url));
	let files = await readdir(assets);
	let main = files.filter(name => /^index-.*\.css$/.test(name));
	let editor = files.filter(name => /^plan-editor-.*\.css$/.test(name));
	expect(main).toHaveLength(1);
	expect(editor).toHaveLength(1);
	stylesheet =
		(await Promise.all([main[0]!, editor[0]!].map(name => readFile(assets + name, "utf8")))).join(
			"\n",
		);
	expect(stylesheet).toContain(".plan-content");
}
export let card = (page: Page) => page.locator("[data-open-card-host]");
export let sourceAction = (page: Page) =>
	card(page).getByRole("button", { name: "Show source in chat", exact: true });
export let openMeta = {
	status: "open" as const,
	origin: "conversation" as const,
	thread: "thread-1",
	involved: ["ana", "ben"],
	history: [],
	optionOrigins: {},
	refining: false,
	hasProse: false,
	proseOrphaned: false,
};
let questionSource = (messageId: string, quote: string) => ({
	messageId,
	quote,
	start: 0,
	end: quote.length,
	role: "question",
	author: { kind: "member", handle: "ana" },
});
let makeThread = (
	id: string,
	questionnaireId: string,
	first: string,
	quote: string,
	second: string,
	secondQuote: string,
) => ({
	id,
	questionnaireId,
	question: "Choose rollout",
	questionSources: [questionSource(first, quote), questionSource(second, secondQuote)],
	questionAuthoring: "quoted",
	status: "exploring",
	contributions: [],
	stances: [],
	stanceHistory: [],
	decisionHistory: [],
	candidates: [],
	version: 1,
});
export async function loadOpenCard(page: Page, { canEdit = false }: { canEdit?: boolean } = {}) {
	let errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	pageErrors.set(page, errors);
	let url = "https://open-card.invalid/";
	await page.route(
		"**/*",
		route =>
			route.request().url() === url && route.request().isNavigationRequest()
				? route.fulfill({
					contentType: "text/html",
					body:
						'<!doctype html><html><head></head><body><div id="fixture"></div><div id="evidence-probe"></div><div id="open-card"></div></body></html>',
				})
				: route.abort(),
	);
	await page.goto(url);
	expect(await page.evaluate(() => ({ mode: document.compatMode, secure: isSecureContext })))
		.toEqual({ mode: "CSS1Compat", secure: true });
	await page.addStyleTag({ content: stylesheet });
	// Only dimensions for the auxiliary host; card and Transcript styles are actual built CSS.
	await page.addStyleTag({
		content:
			"body{margin:0}#fixture{height:700px;width:1200px}#open-card{position:fixed;left:24px;bottom:24px;width:390px;max-height:360px;overflow:auto;z-index:100}",
	});
	await page.addScriptTag({ content: script });
	await page.evaluate(() => window.roomSourceProbe.mount());
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.snapshot().room)).toBe(
		"room-a",
	);
	await expect.poll(() => page.evaluate(() => window.roomSourceProbe.sockets.length)).toBe(1);
	await page.evaluate(threads => {
		window.roomSourceProbe.receive({
			kind: "chat:history",
			entries: [
				{ id: "m1", text: "pilot first", author: { kind: "member", handle: "ana" }, ts: 1 },
				{ id: "m2", text: "broad second", author: { kind: "member", handle: "ana" }, ts: 2 },
			],
			queued: [],
			busy: false,
			ts: 1,
		});
		window.roomSourceProbe.receive({
			kind: "conversation-plan:snapshot",
			state: { schemaVersion: 1, revision: 1, events: [], threads, queue: [], analysis: [] },
			jobs: [],
			ts: 1,
		});
	}, [
		makeThread("thread-1", "card-1", "m1", "pilot", "m2", "broad"),
		makeThread("thread-2", "card-2", "m2", "broad", "m1", "pilot"),
	]);
	await page.evaluate(meta => window.openCardProbe.meta("card-1", meta), openMeta);
	await page.evaluate(canEdit => window.openCardProbe.mountCard("card-1", true, canEdit), canEdit);
	await expect.poll(() => page.evaluate(() => window.openCardProbe.ready())).toBe(true);
	await expect(sourceAction(page)).toBeVisible();
}
export async function assertOpenCardErrors(page: Page) {
	expect(pageErrors.get(page)).toEqual([]);
	expect(await page.evaluate(() => window.openCardProbe.errors)).toEqual([]);
}
