import { content, expect, ready, test, written } from "../room";
import { installProbe } from "./probes";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join as filePath } from "node:path";
import { writerLease } from "./lifetimes";
import { protocolPeer } from "./peer";

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

test("the real authenticated editor has observable resource and editing continuity", async ({ context, join, room, page, browser }) => {
	test.setTimeout(900_000);
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
	let peer = await protocolPeer(browser, new URL(url).origin, room);
	try {
		await expect.poll(peer.text).toContain("An editable frontend baseline.");
		expect(peer.epoch).toBe(before.epoch);
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
		let phases = () =>
			readFile(filePath(root, ".liveapp/logs/publications.ndjson"), "utf8").catch(() => "");
		let acceptedSource = async (path: string, expected: string) => {
			await expect.poll(async () => {
				let project = JSON.parse(await readFile(filePath(root, ".liveapp/project.json"), "utf8"));
				let record = project.records.find((record: { id: string }) =>
					record.id === project.revision.id
				);
				return record.files[path] === expected
					&& (await phases()).includes(`"id":"${record.id}","phase":"accepted"`);
			}, { timeout: 120_000 }).toBe(true);
		};
		let patch = async (path: string, before: string, after: string) => {
			let target = filePath(root, path);
			let source = await readFile(target, "utf8");
			expect(source).toContain(before);
			let next = source.replace(before, after);
			await writeFile(target, next);
			await acceptedSource(path, next);
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
		await acceptedSource(
			"apps/web/src/room-workspace.tsx",
			await readFile(filePath(root, "apps/web/src/room-workspace.tsx"), "utf8"),
		);
		let searchPath = "apps/web/src/document-search-dialog.tsx";
		await patch(searchPath, 'title="Search documents"', 'title="Search live documents"');
		await page.evaluate(() => Reflect.get(globalThis, "__frontendProbe").blockLazy());
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await expect.poll(() =>
			page.evaluate(() => Reflect.get(globalThis, "__frontendProbe").lazyWaiting())
		).toBe(true);
		await patch(searchPath, 'title="Search live documents"', 'title="Search current documents"');
		await page.evaluate(() => Reflect.get(globalThis, "__frontendProbe").releaseLazy());
		await expect(page.getByRole("dialog", { name: "Search current documents" })).toBeVisible();
		let search = page.getByRole("textbox", { name: "Search documents", exact: true });
		await search.fill("Unsent search");
		await patch(
			searchPath,
			"setQuery(event.target.value)",
			"setQuery(event.target.value.trimStart())",
		);
		await expect(search).toHaveValue("Unsent search");
		await search.fill("  new search");
		await expect(search).toHaveValue("new search");
		await page.keyboard.press("Escape");
		await select();
		await continuous();
		let statusPath = "packages/editor/src/status.tsx";
		await writeFile(
			filePath(root, "packages/editor/src/pilot-note.tsx"),
			"export function PilotNote(){return <small>Live editor note</small>}",
		);
		let statusSource = await readFile(filePath(root, statusPath), "utf8");
		await patch(
			statusPath,
			statusSource,
			'import {PilotNote} from "./pilot-note";\n'
				+ statusSource.replace("{detail && (", "<PilotNote />{detail && ("),
		);
		await expect(page.getByText("Live editor note", { exact: true })).toBeVisible();
		await continuous();
		let notePath = "packages/editor/src/pilot-note.tsx";
		let priorPhases = (await phases()).length;
		let changed = patch(notePath, "Live editor note", "Shared editor note");
		await expect.poll(async () => (await phases()).slice(priorPhases), { timeout: 30_000 })
			.toContain('"phase":"checking"');
		await peer.append(" Remote edit.");
		await expect(editor).toContainText("Remote edit.");
		await changed;
		await expect(page.getByText("Shared editor note", { exact: true })).toBeVisible();
		await written(page, room, /An editable frontend baseline\. Remote edit\./);
		await continuous();
		for (let label of ["Repeated editor note", "Final editor note"]) {
			let current = await readFile(filePath(root, notePath), "utf8");
			await patch(notePath, current, `export function PilotNote(){return <small>${label}</small>}`);
			await expect(page.getByText(label, { exact: true })).toBeVisible();
			await continuous();
		}
		let rejected = async (path: string, source: string, diagnostic: string) => {
			let start = (await phases()).length;
			await writeFile(filePath(root, path), source);
			await expect.poll(async () => (await phases()).slice(start), { timeout: 60_000 }).toContain(
				diagnostic,
			);
			await expect(page.getByText("Final editor note", { exact: true })).toBeVisible();
			await continuous();
		};
		let noteSource = await readFile(filePath(root, notePath), "utf8");
		await rejected(notePath, "export function Broken( {", "TS");
		await patch(
			notePath,
			"export function Broken( {",
			noteSource.replace("Final editor note", "Corrected editor note"),
		);
		await expect(page.getByText("Corrected editor note", { exact: true })).toBeVisible();
		await continuous();
		await patch(notePath, "Corrected editor note", "Final editor note");
		await rejected(
			notePath,
			noteSource.replace(
				"return <small>",
				'if(typeof window !== "undefined") throw new Error("pilot leaf failure"); return <small>',
			),
			"pilot leaf failure",
		);
		await writeFile(filePath(root, notePath), noteSource);
		let ownerPath = "apps/web/src/room-workspace.tsx";
		let ownerSource = await readFile(filePath(root, ownerPath), "utf8");
		await rejected(
			ownerPath,
			ownerSource.replace("let sourceToken = useRef(0);", "let sourceToken = useRef(1);"),
			"hook or resource initialization changed",
		);
		await writeFile(filePath(root, ownerPath), ownerSource);
		await patch(notePath, "Final editor note", "Recovered editor note");
		await expect(page.getByText("Recovered editor note", { exact: true })).toBeVisible();
		await continuous();
		let provider = process.env.LIVEAPP_TEST_PROVIDER!;
		await page.request.post(provider + "/script", {
			data: [
				{ name: "inspect_project", arguments: {} },
				{
					name: "edit_source",
					arguments: {
						path: notePath,
						oldText: "Recovered editor note",
						newText: "Stale agent note",
					},
				},
				{ name: "check_candidate", arguments: { summary: "Prepare a stale candidate" } },
				{ name: "publish_revision", arguments: {}, pause: true },
			],
		});
		await page.getByRole("button", { name: "Open LiveApp Developer" }).click();
		await developer.getByRole("textbox", { name: "Describe an app change" }).fill(
			"Prepare an editor-note change.",
		);
		await developer.getByRole("button", { name: "Send message", exact: true }).click();
		await developer.getByRole("button", { name: "Collapse developer widget" }).click();
		// Reselect the original local range, not the text appended by the peer.
		await page.evaluate(() => {
			let root = document.querySelector('[aria-label="editable markdown"]')!;
			let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			let text: Node | null;
			while ((text = walker.nextNode())) {
				let at = text.textContent?.indexOf("baseline.") ?? -1;
				if (at < 0) continue;
				let range = document.createRange();
				range.setStart(text, at + 7);
				range.setEnd(text, at + 9);
				getSelection()!.removeAllRanges();
				getSelection()!.addRange(range);
				break;
			}
		});
		await expect.poll(
			async () =>
				(await page.request.get(provider + "/state").then(response => response.json())).paused,
			{ timeout: 60_000 },
		).toBe(true);
		await patch(notePath, "Recovered editor note", "Manual editor note");
		await page.request.post(provider + "/release");
		await expect.poll(
			() =>
				page.evaluate(() =>
					Reflect.get(globalThis, "__liveappAutomaticClient").store.snapshot().error
				),
			{ timeout: 30_000 },
		).toContain("manual edits were preserved");
		await expect(page.getByText("Manual editor note", { exact: true })).toBeVisible();
		expect(await readFile(filePath(root, notePath), "utf8")).toContain("Manual editor note");
		await continuous();
		expect(requests.some(url => /@vite\/client|@react-refresh/.test(url))).toBe(false);
		expect(hot).toEqual([]);
	} finally {
		peer.close();
	}
});
