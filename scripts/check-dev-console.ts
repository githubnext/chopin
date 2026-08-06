#!/usr/bin/env bun
/**
 * The console, read while a plan with code in it is edited.
 *
 * React's duplicate-key warning — and every other invariant it reports at
 * runtime — exists only in a development build. `bun run e2e` serves
 * `apps/web/dist`, where the minifier has removed all of it, so a Playwright
 * test asserting a clean console there passes whether or not anything is wrong.
 * The only place the warning can be seen is a browser pointed at the dev
 * client, which is what this starts.
 *
 * It is not part of `bun run ci` because it needs a browser. Run it with
 * `bun run check:console`, after `bun run e2e:browsers` once.
 *
 * Ports are taken from the OS rather than from `apps/web/vite.config.ts`, so
 * this can run beside a dev server already holding 5173. That means overriding
 * `server.hmr.clientPort` too — the client is told where to reach HMR at build
 * time, and left at the config's default it would spend the run reporting a
 * socket it cannot open, in the console this exists to read.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { chromium } from "@playwright/test";

import type { ConsoleMessage } from "@playwright/test";
import type { Subprocess } from "bun";
import type { ViteDevServer } from "vite";

const ROOT = dirname(import.meta.dir);
const WEB = join(ROOT, "apps/web");
const HOST = "127.0.0.1";

/** Where the screenshot this produces is kept, beside the task it answers. */
const SHOT = join(ROOT, "tasks/images/006-console.png");

/** Beside the rooms the e2e suite invents, and ignored by git for the same reason. */
const DATA = join(ROOT, "e2e/.scratch/console");
const ROOM = "console-check";

const READY_MS = 60_000;

/**
 * A plan with one of everything that draws.
 *
 * Two fences and a formula, each of which mounts a preview and a row of
 * chrome, and paragraphs above and below the first fence — the acceptance is
 * about typing *next to* a block, and a plan of nothing but blocks has nowhere
 * to do that.
 */
const PLAN = `# A plan with code in it

A paragraph before the fence.

\`\`\`ts
export function hello(name: string) {
	return \`hello \${name}\`;
}
\`\`\`

A paragraph between the blocks.

\`\`\`diff
--- a/apps/server/src/plan/room.ts
+++ b/apps/server/src/plan/room.ts
@@ -1,9 +1,9 @@
 export function open(room: string): Plan {
-	return { doc, epoch: 1 };
+	let epoch = rotate(room);
+	return { doc, epoch };
 }
\`\`\`

$$
\\int_0^1 x^2 dx = \\frac{1}{3}
$$

A paragraph after everything.
`;

/*
 * Two messages a dev build makes on its own, neither of them React and neither
 * of them this app's doing. StrictMode mounts every effect twice, so the first
 * collaboration socket is closed before it finishes opening; and the page ships
 * no favicon, which the browser asks for anyway. They are named rather than
 * filtered by level, so that anything else arriving is still a surprise.
 */
const EXPECTED = [
	/WebSocket is closed before the connection is established/,
	/favicon\.ico/,
];

let messages: { type: string; text: string }[] = [];
let checks: { name: string; ok: boolean; detail: string }[] = [];

function record(message: ConsoleMessage): void {
	messages.push({ type: message.type(), text: message.text() });
}

/** Every duplicate-key report, which is the one this task is about. */
function duplicates(from = 0): string[] {
	return messages.slice(from).filter(m => /same key/i.test(m.text)).map(m => m.text);
}

/** Anything else a dev build complained about, which should be nothing new. */
function unexpected(from = 0): string[] {
	return messages
		.slice(from)
		.filter(m => m.type === "error" || m.type === "warning")
		.filter(m => !EXPECTED.some(pattern => pattern.test(m.text)))
		.map(m => `[${m.type}] ${m.text}`);
}

function check(name: string, ok: boolean, detail = ""): void {
	checks.push({ name, ok, detail });
	console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
}

/** A port the OS has just confirmed is free. */
function free(): number {
	let socket = Bun.listen({ hostname: HOST, port: 0, socket: { data() {} } });
	let port = socket.port;
	socket.stop(true);
	return port;
}

async function reachable(url: string): Promise<void> {
	let deadline = Date.now() + READY_MS;
	while (Date.now() < deadline) {
		try {
			let response = await fetch(url, { redirect: "manual" });
			await response.body?.cancel();
			if (response.ok) return;
		} catch {}
		await Bun.sleep(250);
	}
	throw new Error(`chopin: ${url} never answered`);
}

let vite: ViteDevServer | undefined;
let server: Subprocess | undefined;

async function stop(): Promise<void> {
	// Its own process group, killed as a group, for the reason `scripts/dev.ts`
	// gives at length: the leader alone leaves esbuild behind holding a port.
	if (server) {
		try {
			process.kill(-server.pid, "SIGTERM");
		} catch {}
	}
	await vite?.close();
}

try {
	rmSync(join(DATA, ROOM), { recursive: true, force: true });
	mkdirSync(join(DATA, ROOM), { recursive: true });
	writeFileSync(join(DATA, ROOM, "plan.mdx"), PLAN);

	let webPort = free();
	let appPort = free();

	// Resolved from `apps/web`, which is the only place it is installed —
	// nothing hoists it to the root, and this script lives above both.
	let { createServer } = await import(Bun.resolveSync("vite", WEB)) as typeof import("vite");

	vite = await createServer({
		root: WEB,
		configFile: join(WEB, "vite.config.ts"),
		server: { host: HOST, port: webPort, strictPort: true, hmr: { clientPort: webPort } },
	});
	await vite.listen();

	server = Bun.spawn(["bun", "src/main.ts"], {
		cwd: join(ROOT, "apps/server"),
		env: {
			...process.env,
			PORT: String(appPort),
			SERVER_HOST: HOST,
			AGENT: "off",
			DATA_DIR: DATA,
			DEV_QUESTIONS: "",
			DEV_COMMENTS: "",
			DEV_CLIENT: `http://${HOST}:${webPort}`,
		},
		stdio: ["inherit", "ignore", "inherit"],
		detached: true,
	});

	let base = `http://${HOST}:${appPort}`;
	// The server 502s until Vite is up, so a reply means both halves are ready.
	await reachable(base);

	let browser = await chromium.launch();
	let page = await browser.newPage();
	page.on("console", record);
	page.on("pageerror", error => messages.push({ type: "error", text: String(error) }));

	await page.goto(`${base}/r/${ROOM}?as=ana`);

	let content = page.getByRole("textbox", { name: "editable markdown" });
	// readOnly is offline || busy || !synced, so an editable surface is the
	// room being open — the same fact `e2e/room.ts` waits on.
	await content.waitFor({ state: "visible", timeout: READY_MS });
	await page.waitForFunction(
		() =>
			document.querySelector('[aria-label="editable markdown"]')
				?.getAttribute("contenteditable") === "true",
		null,
		{ timeout: READY_MS },
	);
	// Each renderer is loaded on demand, so the page is not finished when the
	// text arrives — and a console read before the drawing is a console read
	// before the portals this is about have been mounted.
	for (let drawn of ["[data-file]", "[data-diff]", ".katex"]) {
		await page.locator(drawn).first().waitFor({ timeout: READY_MS });
	}

	// 1 — opening a plan containing a code block.
	check(
		"opening the plan reports no duplicate key",
		duplicates().length === 0,
		report(duplicates()),
	);

	// Everything drew, so the console above was read against a page that had
	// something to warn about. A blank plan has a clean console too.
	let drew = {
		code: await page.locator("[data-file]").count(),
		patch: await page.locator("[data-diff]").count(),
		formula: await page.locator(".katex").count(),
	};
	check(
		"all three blocks drew a preview",
		drew.code === 1 && drew.patch === 1 && drew.formula >= 1,
		`code ${drew.code}, patch ${drew.patch}, formula ${drew.formula}`,
	);
	check(
		"and each of them a row of chrome",
		await page.getByRole("button", { name: "Hide source" }).count() === 3,
	);

	// 2 — typing inside a paragraph next to a code block. One commit per
	// character, and the warning came in bursts of one per commit.
	let mark = messages.length;
	// Clicked into, then sent to the end of the line. The caret lands where the
	// click does, and this run is photographed — a sentence with a word split
	// down the middle of it reads as something having gone wrong. `End` is not
	// the key that does this on macOS, where it scrolls the page instead and
	// leaves the caret in the middle of the word that was clicked.
	await content.getByText("A paragraph between the blocks.").click();
	await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");
	await page.keyboard.type(" Typing beside a fence.", { delay: 10 });
	await page.waitForTimeout(500);

	let landed = (await content.innerText()).includes("Typing beside a fence.");
	check(
		"the typing reached the document",
		landed,
		landed ? "" : "nothing below this means anything",
	);
	check(
		"typing beside a fence reports no duplicate key",
		duplicates(mark).length === 0,
		report(duplicates(mark)),
	);

	// 4 — collapsing survives an edit elsewhere.
	mark = messages.length;
	let fence = page.locator("[data-plan-chrome='block']")
		.filter({ has: page.getByLabel("Code language") })
		.first();
	await fence.getByRole("button", { name: "Hide source" }).click();
	await content.getByText("A paragraph after everything.").click();
	await page.keyboard.type("Edited well away from it. ", { delay: 10 });
	await page.waitForTimeout(500);

	check(
		"a collapsed fence is still collapsed after editing elsewhere",
		await fence.getByRole("button", { name: "Show source" }).count() === 1,
	);
	check(
		"collapsing and editing reports no duplicate key",
		duplicates(mark).length === 0,
		report(duplicates(mark)),
	);

	check("nothing else was reported either", unexpected().length === 0, report(unexpected()));

	// Back to the top, so the picture has the fence and the paragraph typed
	// beside it in it — the console below is about that, and a screenshot of
	// the end of the plan would leave a reader taking the subject on trust.
	await page.mouse.move(640, 200);
	await page.mouse.wheel(0, -4_000);
	await page.waitForTimeout(300);

	await panel(page);
	mkdirSync(dirname(SHOT), { recursive: true });
	await page.screenshot({ path: SHOT });
	await browser.close();

	let failed = checks.filter(c => !c.ok);
	console.log(
		`\n${checks.length - failed.length}/${checks.length} checks passed`
			+ `  ·  ${messages.length} console messages, ${duplicates().length} of them duplicate keys`
			+ `\nscreenshot: ${SHOT.replace(`${ROOT}/`, "")}`,
	);
	if (failed.length) process.exitCode = 1;
} finally {
	await stop();
}

function report(lines: string[]): string {
	return lines.length ? `${lines.length}: ${lines[0]?.slice(0, 120)}` : "";
}

/**
 * Escaped on this side of the bridge.
 *
 * The panel below is serialised and re-evaluated inside the page, where it can
 * reach nothing this file declares — and the text it is drawing is console
 * output, which is exactly the kind of string that arrives with markup in it.
 */
function escape(text: string): string {
	return text.replace(/[<&]/g, c => c === "<" ? "&lt;" : "&amp;");
}

/**
 * The console, drawn into the page so it can be photographed.
 *
 * A screenshot is the acceptance, and no browser lets one be taken of its own
 * devtools. So every message this run collected is put back on the page it
 * came from, unfiltered and with its level, and the picture is of that.
 */
async function panel(page: import("@playwright/test").Page): Promise<void> {
	await page.evaluate(
		({ lines, rows, headline }) => {
			let box = document.createElement("div");
			box.style.cssText = "position:fixed;inset:auto 0 0 0;z-index:99999;background:#1b1b1b;"
				+ "color:#d4d4d4;font:12px/1.7 ui-monospace,SFMono-Regular,monospace;padding:14px 18px;"
				+ "max-height:58vh;overflow:auto;border-top:2px solid #3c3c3c";
			box.innerHTML = `<div style="color:#dcdcaa;font-weight:600">${headline}</div>`
				+ `<div style="color:#7f7f7f;margin:8px 0 4px">Every message the page emitted (${lines.length})</div>`
				+ (lines.length
					? lines.map(l =>
						`<div><span style="display:inline-block;width:72px;color:${
							l.type === "error" ? "#f48771" : l.type === "warning" ? "#dcdcaa" : "#6a7a8a"
						}">${l.type}</span>${l.text}</div>`
					).join("")
					: `<div style="color:#6a9955">none</div>`)
				+ `<div style="color:#7f7f7f;margin:10px 0 4px">Checks</div>`
				+ rows.map(r =>
					`<div style="color:${r.ok ? "#6a9955" : "#f48771"}">${
						r.ok ? "  ok  " : " FAIL "
					} ${r.name}</div>`
				).join("");
			document.body.appendChild(box);
		},
		{
			lines: messages.map(m => ({ type: m.type, text: escape(m.text).slice(0, 220) })),
			rows: checks.map(c => ({ ok: c.ok, name: escape(c.name) })),
			headline: escape(
				`Duplicate-key warnings while opening and editing this plan: ${duplicates().length}`,
			),
		},
	);
}
