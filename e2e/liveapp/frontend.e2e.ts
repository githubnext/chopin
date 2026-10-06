import { content, expect, ready, test, written } from "../room";
import { installProbe } from "./probes";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join as filePath } from "node:path";
import { writerLease } from "./lifetimes";

test.afterEach(async ({ page }, info) => {
	if (process.env.LIVEAPP_TEST_INTEGRATED !== "1") return;
	await info.attach("application-url", { body: page.url(), contentType: "text/plain" });
	let logs = await readFile(
		filePath(process.env.LIVEAPP_TEST_ROOT!, ".liveapp/logs/publications.ndjson"),
		"utf8",
	).catch(() => "");
	await info.attach("publication-phases", { body: logs, contentType: "text/plain" });
	if (info.status !== info.expectedStatus) console.log(logs);
	if (info.status !== info.expectedStatus) {
		console.log(
			await page.evaluate(() =>
				Reflect.get(globalThis, "__liveappAutomaticClient")?.store.snapshot()
			),
		);
		let directory = filePath(process.env.LIVEAPP_TEST_ROOT!, ".liveapp/frontend");
		for (let name of await readdir(directory)) {
			if (name.endsWith(".json")) {
				await info.attach(name, {
					body: await readFile(filePath(directory, name)),
					contentType: "application/json",
				});
			}
		}
	}
});

test("the real authenticated editor has observable resource and editing continuity", async ({ context, join, room, page }) => {
	test.setTimeout(360_000);
	let requests: string[] = [], hot: string[] = [], sockets: string[] = [], closed: string[] = [];
	page.on("request", request => requests.push(request.url()));
	page.on("websocket", socket => {
		sockets.push(socket.url());
		socket.on("close", () => closed.push(socket.url()));
		socket.on("framereceived", event => {
			try {
				let type = JSON.parse(String(event.payload)).type;
				if (["update", "prune", "full-reload"].includes(type)) hot.push(type);
			} catch {}
		});
	});
	await context.addInitScript(installProbe);
	await join("ana");
	let editor = content(page);
	await ready(page);
	if (process.env.LIVEAPP_TEST_INTEGRATED === "1") {
		await page.getByRole("button", { name: "Collapse developer widget" }).click();
	}
	await page.evaluate(() =>
		Reflect.get(globalThis, "__frontendProbe").remember("dom", {
			document,
			root: document.getElementById("root"),
			editor: document.querySelector('[aria-label="editable markdown"]'),
		})
	);
	let snapshot = () => page.evaluate(() => Reflect.get(globalThis, "__frontendProbe").snapshot());
	let before = await snapshot();
	expect(Object.keys(before.ids)).toEqual(expect.arrayContaining([
		"editor.editor",
		"editor.binding",
		"editor.provider",
		"editor.doc",
		"room.socket",
	]));
	let session = await page.request.get("/api/session").then(response => response.json());
	expect(session.user).toBeTruthy();
	await editor.click();
	await page.keyboard.type("An editable frontend baseline.");
	await written(page, room, /An editable frontend baseline\./);
	await page.keyboard.press("Shift+ArrowLeft");
	await page.keyboard.press("Shift+ArrowLeft");
	expect(await page.evaluate(() => getSelection()?.toString())).toBe("e.");
	expect(await snapshot()).toEqual(before);
	await page.getByRole("combobox", { name: /^Use @/ }).fill("An unsent message");
	expect(await snapshot()).toEqual(before);
	await expect(editor).toContainText("An editable frontend baseline.");
	await expect(page.getByRole("combobox", { name: /^Use @/ })).toHaveValue("An unsent message");
	expect(await page.request.get("/api/session").then(response => response.json())).toEqual(session);
	if (process.env.LIVEAPP_TEST_INTEGRATED !== "1") return;
	let lease = await writerLease();
	let connected = [...sockets], disconnected = [...closed], url = page.url();
	let navigations = 0;
	page.on("framenavigated", frame => {
		if (frame === page.mainFrame()) navigations++;
	});
	let select = async () => {
		await editor.click();
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.press("Shift+ArrowLeft");
		await page.keyboard.press("Shift+ArrowLeft");
		expect(await page.evaluate(() => getSelection()?.toString())).toBe("e.");
	};
	let continuous = async () => {
		expect(await snapshot()).toEqual(before);
		await expect(page.getByRole("combobox", { name: /^Use @/ })).toHaveValue("An unsent message");
		expect(await page.evaluate(() => getSelection()?.toString())).toBe("e.");
		expect(page.url()).toBe(url);
		expect(navigations).toBe(0);
		expect(sockets).toEqual(connected);
		expect(closed).toEqual(disconnected);
		expect(await writerLease()).toEqual(lease);
		expect(await page.request.get("/api/session").then(response => response.json())).toEqual(
			session,
		);
		expect(() => process.kill(Number(process.env.LIVEAPP_TEST_PID), 0)).not.toThrow();
	};
	await select();
	let root = process.env.LIVEAPP_TEST_ROOT!;
	let patch = async (path: string, before: string, after: string) => {
		let accepted = async () =>
			(await readFile(filePath(root, ".liveapp/logs/publications.ndjson"), "utf8").catch(() => ""))
				.split('"phase":"accepted"').length;
		let previous = await accepted();
		let target = filePath(root, path);
		let source = await readFile(target, "utf8");
		expect(source).toContain(before);
		await writeFile(target, source.replace(before, after));
		await expect.poll(accepted, { timeout: 60_000 }).toBeGreaterThan(previous);
	};
	await patch(
		"apps/web/src/project-sidebar.tsx",
		'className="project-sidebar" data-project-sidebar',
		'className="project-sidebar outline-solid outline-[7px]" data-project-sidebar',
	);
	await expect(page.getByRole("complementary", { name: "Projects", exact: true })).toHaveCSS(
		"outline-width",
		"7px",
		{ timeout: 60_000 },
	);
	await continuous();
	await patch(
		"packages/editor/src/status.tsx",
		'label: "Ready", tone: "muted", level: "hidden"',
		'label: "Ready for live edits", tone: "muted", level: "notice"',
	);
	await expect(page.locator(".plan-status")).toHaveText("Ready for live edits", {
		timeout: 60_000,
	});
	await expect(page.getByText("Ready for live edits", { exact: true })).toBeVisible();
	await continuous();
	await page.getByRole("button", { name: "Open LiveApp Developer" }).click();
	let developer = page.getByRole("dialog", { name: "LiveApp Developer" });
	await developer.getByRole("textbox", { name: "Describe an app change" }).fill(
		"Update the workspace title while preserving this editing session.",
	);
	await developer.getByRole("button", { name: "Send message", exact: true }).click();
	await developer.getByRole("button", { name: "Collapse developer widget" }).click();
	await select();
	await expect(page.getByRole("button", { name: /^Actions for .* · live$/ })).toBeVisible({
		timeout: 60_000,
	});
	await continuous();
	expect(await readFile(filePath(root, "apps/web/src/room-workspace.tsx"), "utf8")).toContain(
		"label={`${metadata.title} · live`}",
	);
	expect(requests.some(url => /@vite\/client|@react-refresh/.test(url))).toBe(false);
	expect(hot).toEqual([]);
});
