import { expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { binding, response } from "./agenda.fixture";

import type { Page, Route } from "@playwright/test";
import type { Agenda } from "../../packages/protocol/index";

let script: string;
let stylesheet: string;
let agendaStyle: string;

export async function prepareAgenda() {
	if (typeof Bun === "undefined") throw new Error("Run through bun --bun");
	let entry = fileURLToPath(
		new URL("../../apps/web/src/research-agenda/agenda-dialog.tsx", import.meta.url),
	);
	let result = await Bun.build({
		entrypoints: [entry],
		target: "browser",
		format: "iife",
		plugins: [{
			name: "real-agenda-fixture",
			setup(build) {
				build.onLoad({ filter: /\/research-agenda\/agenda-dialog\.tsx$/ }, async args => ({
					loader: "tsx",
					contents: await Bun.file(args.path).text() + binding,
				}));
			},
		}],
	});
	expect(result.success, JSON.stringify(result.logs)).toBe(true);
	script = await result.outputs.find(output => output.path.endsWith(".js"))!.text();
	agendaStyle = await result.outputs.find(output => output.path.endsWith(".css"))!.text();
	let output = fileURLToPath(new URL("../../apps/web/dist/", import.meta.url));
	let html = await readFile(output + "index.html", "utf8");
	let style = html.match(/href="(\/assets\/[^" ]+\.css)"/);
	expect(style).not.toBeNull();
	stylesheet = await readFile(output + style![1].slice(1), "utf8");
}

export type Mutation = { method: string; url: string; body: Record<string, unknown> };

export async function load(
	page: Page,
	initial = response(),
	handle?: (route: Route, mutations: Mutation[]) => Promise<boolean>,
) {
	let errors: string[] = [];
	let mutations: Mutation[] = [];
	let snapshot = initial;
	page.on("pageerror", error => errors.push(error.message));
	await page.route("**/*", async route => {
		let request = route.request();
		if (request.isNavigationRequest()) {
			await route.fulfill({
				contentType: "text/html",
				body: '<!doctype html><html><head></head><body><div id="fixture"></div></body></html>',
			});
			return;
		}
		if (!request.url().includes("/research-agenda")) {
			let asset = new URL(request.url()).pathname;
			if (/^\/assets\/[\w.-]+\.woff2?$/.test(asset)) {
				let output = fileURLToPath(new URL("../../apps/web/dist/", import.meta.url));
				await route.fulfill({
					contentType: asset.endsWith("woff2") ? "font/woff2" : "font/woff",
					body: await readFile(output + asset.slice(1)),
				});
				return;
			}
			await route.abort();
			return;
		}
		if (request.method() !== "GET") {
			mutations.push({
				method: request.method(),
				url: request.url(),
				body: request.postDataJSON(),
			});
		}
		if (handle && await handle(route, mutations)) return;
		await route.fulfill({ json: snapshot });
	});
	await page.goto("https://agenda-native.invalid/");
	await page.addStyleTag({ content: stylesheet + agendaStyle });
	await page.addScriptTag({ content: script });
	await page.getByRole("button", { name: "Research agenda", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "Research agenda", exact: true })).toBeVisible();
	await expect(page.getByText("Up to 3 investigations · 24 hours", { exact: true })).toBeVisible();
	return {
		errors,
		mutations,
		set(next: Agenda.Response) {
			snapshot = next;
		},
	};
}
