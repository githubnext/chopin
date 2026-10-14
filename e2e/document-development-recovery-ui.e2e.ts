import { authenticate, content, expect, ready, roomPath, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";
import type { DocumentDevelopment } from "../packages/protocol/index";
import type { Page, WebSocketRoute } from "@playwright/test";

let first = {
	id: "saved-a",
	digest: `sha256:${"a".repeat(64)}`,
	preview: "A later human clarification",
};
let second = {
	id: "saved-b",
	digest: `sha256:${"b".repeat(64)}`,
	preview: "A second saved passage",
};
let updated = {
	...first,
	digest: `sha256:${"c".repeat(64)}`,
	preview: "The latest human clarification",
};
let saved = "A complete human clarification.\n\n<script>window.recoveredCodeRan = true</script>";
type Request = {
	kind: string;
	rid: string;
	id: string;
	digest: string;
	action?: "add" | "dismiss";
};

/** The ordinary server keeps the feature off; only the recovery frames are supplied here. */
async function recoveryWire(page: Page) {
	let routes: WebSocketRoute[] = [];
	let reads: Request[] = [];
	let resolutions: Request[] = [];
	let items: DocumentDevelopment.RecoverySummary[] = [];
	let hold = false;
	let holdResolve = false;
	let blocked = false;
	let reply = (request: Request, source = saved) =>
		routes.at(-1)!.send(JSON.stringify({
			kind: "document-development:recovery-read",
			ts: 0,
			rid: request.rid,
			item: { id: request.id, digest: request.digest, source },
		}));
	let send = (next: DocumentDevelopment.RecoverySummary[], rid?: string) => {
		items = next;
		routes.at(-1)!.send(
			JSON.stringify({ kind: "document-development:recovery-state", ts: 0, rid, items }),
		);
	};
	await page.routeWebSocket("**/ws?**", route => {
		routes.push(route);
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as Request;
				if (frame.kind === "document-development:recovery-read") {
					reads.push(frame);
					if (!hold) reply(frame);
					return;
				}
				if (frame.kind === "document-development:recovery-resolve") {
					resolutions.push(frame);
					if (holdResolve) return;
					if (blocked) {
						route.send(JSON.stringify({
							kind: "session:error",
							ts: 0,
							rid: frame.rid,
							message: "Recovered edits cannot be added while the document is locked.",
						}));
					} else send(items.filter(item => item.id !== frame.id), frame.rid);
					return;
				}
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string };
				if (frame.kind.startsWith("document-development:")) return;
			}
			route.send(message);
		});
	});
	return {
		routes,
		reads,
		resolutions,
		reply,
		send,
		draft: () =>
			routes.at(-1)!.send(JSON.stringify({
				kind: "document-development:state",
				ts: 0,
				paused: false,
				pending: false,
				generated: 2,
				protected: 1,
			})),
		hold: (next: boolean) => {
			hold = next;
		},
		block: (next: boolean) => {
			blocked = next;
		},
		holdResolve: (next: boolean) => {
			holdResolve = next;
		},
	};
}

test(
	"saved human edits can be inspected, added or dismissed with keyboard focus and a blocked retry",
	async ({ join, page, seed }, info) => {
		await seed("# Shared document\n\nCurrent human prose.\n");
		let wire = await recoveryWire(page);
		await join("ana");
		let trigger = page.getByRole("button", { name: "Recovered edits (2)", exact: true });
		await expect(trigger).toHaveCount(0);
		wire.send([first, second]);
		await trigger.focus();
		await page.keyboard.press("Enter");
		let dialog = page.getByRole("dialog", { name: "Recovered edits", exact: true });
		await dialog.getByRole("button", { name: first.preview, exact: true }).click();
		await expect(dialog.getByRole("region", { name: "Saved human text" })).toHaveText(saved);
		expect(await page.evaluate(() => "recoveredCodeRan" in window)).toBe(false);
		expect(wire.reads[0]).toMatchObject({ id: first.id, digest: first.digest });
		wire.block(true);
		await dialog.getByRole("button", { name: "Add to document", exact: true }).click();
		await expect(dialog.getByRole("alert")).toContainText("document is locked");
		await expect(dialog.getByRole("region", { name: "Saved human text" })).toHaveText(saved);
		await page.screenshot({ path: info.outputPath("recovered-edits-review.png"), fullPage: true });
		wire.block(false);
		await dialog.getByRole("button", { name: "Add to document", exact: true }).click();
		await expect(dialog.getByRole("button", { name: second.preview, exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		let remaining = page.getByRole("button", { name: "Recovered edits (1)", exact: true });
		await expect(remaining).toBeFocused();
		await remaining.click();
		await dialog.getByRole("button", { name: second.preview, exact: true }).click();
		await dialog.getByRole("button", { name: "Dismiss", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByRole("button", { name: /^Recovered edits/ })).toHaveCount(0);
		await expect(content(page)).toBeFocused();
		expect(wire.resolutions.map(request => [request.id, request.digest, request.action])).toEqual([
			[first.id, first.digest, "add"],
			[first.id, first.digest, "add"],
			[second.id, second.digest, "dismiss"],
		]);
	},
);

test("empty draft controls leave a reader's header spacing unchanged", async ({ baseURL, room, page, seed }) => {
	await seed("# Shared document\n\nCurrent human prose.\n");
	await page.setViewportSize({ width: 1280, height: 720 });
	let wire = await recoveryWire(page);
	await authenticate(page, "readonly", baseURL!);
	await page.goto(roomPath(room));
	await expect(content(page)).toContainText("Current human prose.");
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	let bar = page.locator("[data-document-title-bar]");
	let status = bar.locator(".document-title-status");
	let people = bar.getByRole("group", { name: /^People here/ });
	await expect(bar.locator(".document-development-row")).toBeHidden();
	await expect(status).toHaveCSS("padding-inline-end", "0px");
	await expect(people).toHaveCSS("border-inline-start-width", "0px");
	wire.send([first]);
	await expect(bar.getByRole("button", { name: "Recovered edits (1)", exact: true }))
		.toBeVisible();
	await expect(status).not.toHaveCSS("padding-inline-end", "0px");
	await expect(people).not.toHaveCSS("border-inline-start-width", "0px");
	wire.send([]);
	await expect(status).toHaveCSS("padding-inline-end", "0px");
	await expect(people).toHaveCSS("border-inline-start-width", "0px");
});

test("compact draft status and recovered edits share one row above document prose", async ({ join, page, seed }) => {
	await seed("# Shared document\n\nCurrent human prose.\n");
	await page.setViewportSize({ width: 390, height: 844 });
	let wire = await recoveryWire(page);
	await join("ana");
	await page.getByRole("navigation", { name: "Workspace view", exact: true })
		.getByRole("button", { name: /^Document/ }).click();
	wire.draft();
	wire.send([first]);
	let status = page.getByRole("group", { name: "Document draft updates", exact: true });
	let recovered = page.getByRole("button", { name: "Recovered edits (1)", exact: true });
	await expect(status).toBeVisible();
	await expect(recovered).toBeVisible();
	let draftBox = (await status.boundingBox())!;
	let recoveredBox = (await recovered.boundingBox())!;
	let prose =
		(await content(page).getByText("Current human prose.", { exact: true }).boundingBox())!;
	let title = (await content(page).getByRole("heading", { level: 1 }).boundingBox())!;
	expect(Math.abs(draftBox.y + draftBox.height / 2 - recoveredBox.y - recoveredBox.height / 2))
		.toBeLessThanOrEqual(2);
	expect(Math.max(draftBox.y + draftBox.height, recoveredBox.y + recoveredBox.height))
		.toBeLessThanOrEqual(prose.y);
	expect(Math.max(draftBox.y + draftBox.height, recoveredBox.y + recoveredBox.height))
		.toBeLessThanOrEqual(title.y);
	await expectNoHorizontalOverflow(page);
});

test(
	"draft and recovery labels fold clear of split header actions",
	async ({ join, page, seed }, info) => {
		await seed("# Shared document\n\nCurrent human prose.\n");
		await page.setViewportSize({ width: 1280, height: 720 });
		let wire = await recoveryWire(page);
		await join("ana");
		wire.draft();
		wire.send([first]);
		let bar = page.locator("[data-document-title-bar]");
		let draft = bar.getByRole("group", { name: "Document draft updates", exact: true });
		let recovered = bar.getByRole("button", { name: "Recovered edits (1)", exact: true });
		await expect(draft.getByRole("status")).toHaveAccessibleName("Provisional draft");
		await expect(draft.getByRole("button", { name: "Pause draft updates", exact: true }))
			.toBeVisible();
		await expect(draft.locator("[data-status-label]")).toBeHidden();
		await expect(recovered.locator("[data-status-label]")).toBeHidden();
		await expect(draft.locator(".document-development-glyph")).toBeVisible();
		await expect(recovered.locator(".document-development-glyph")).toBeVisible();
		await expect(bar.locator(".machine-button-name")).toBeHidden();
		let targets = [
			{ name: "Project", locator: bar.locator(".document-project-prefix") },
			{ name: "Document actions", locator: bar.getByRole("button", { name: /^Actions for / }) },
			{ name: "Build plan", locator: bar.getByRole("button", { name: "Build plan", exact: true }) },
			{ name: "Machine", locator: bar.locator(".machine-button") },
			{ name: "Draft", locator: draft },
			{ name: "Recovery", locator: recovered },
		];
		let bounds = [];
		for (let target of targets) {
			await expect(target.locator).toBeVisible();
			bounds.push({ name: target.name, ...(await target.locator.boundingBox())! });
		}
		await page.screenshot({
			path: info.outputPath("document-draft-header-1280.png"),
			fullPage: true,
		});
		for (let [index, left] of bounds.entries()) {
			for (let right of bounds.slice(index + 1)) {
				let width = Math.min(left.x + left.width, right.x + right.width)
					- Math.max(left.x, right.x);
				let height = Math.min(left.y + left.height, right.y + right.height)
					- Math.max(left.y, right.y);
				expect(
					width <= 0 || height <= 0,
					`${JSON.stringify(left)} overlaps ${JSON.stringify(right)}`,
				).toBe(true);
			}
		}
		let header = (await bar.boundingBox())!;
		for (let button of await bar.getByRole("button").all()) {
			let bound = (await button.boundingBox())!;
			let name = await button.getAttribute("aria-label") ?? await button.innerText();
			expect(
				bound.x >= header.x && bound.y >= header.y
					&& bound.x + bound.width <= header.x + header.width
					&& bound.y + bound.height <= header.y + header.height,
				`${name} ${JSON.stringify(bound)} is outside header ${JSON.stringify(header)}`,
			).toBe(true);
		}
		await expectNoHorizontalOverflow(page);
		await page.setViewportSize({ width: 1920, height: 900 });
		await expect(draft.locator("[data-status-label]")).toBeVisible();
		await expect(recovered.locator("[data-status-label]")).toBeVisible();
		await expect(bar.locator(".machine-button-name")).toBeVisible();
		await page.screenshot({
			path: info.outputPath("document-draft-header-wide.png"),
			fullPage: true,
		});
	},
);

test("long recovered text and actions remain reachable on short and landscape screens", async ({ join, page, seed }) => {
	await seed("# Shared document\n\nCurrent human prose.\n");
	let wire = await recoveryWire(page);
	await join("ana");
	wire.hold(true);
	for (let viewport of [{ width: 390, height: 400 }, { width: 844, height: 390 }]) {
		await page.setViewportSize(viewport);
		let documentTab = page.getByRole("navigation", { name: "Workspace view", exact: true })
			.getByRole("button", { name: /^Document/ });
		if (await documentTab.isVisible()) await documentTab.click();
		wire.send([first]);
		await page.getByRole("button", { name: "Recovered edits (1)", exact: true }).click();
		let dialog = page.getByRole("dialog", { name: "Recovered edits", exact: true });
		let reads = wire.reads.length;
		await dialog.getByRole("button", { name: first.preview, exact: true }).click();
		await expect.poll(() => wire.reads.length).toBeGreaterThan(reads);
		wire.reply(wire.reads.at(-1)!, "A saved human paragraph with detail.\n\n".repeat(200));
		await expect(dialog.getByRole("region", { name: "Saved human text" })).toContainText(
			"with detail",
		);
		let box = (await dialog.boundingBox())!;
		expect(box.y).toBeGreaterThanOrEqual(0);
		expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
		let add = dialog.getByRole("button", { name: "Add to document", exact: true });
		await add.scrollIntoViewIfNeeded();
		await expect(add).toBeInViewport();
		let close = dialog.getByRole("button", { name: "Close", exact: true });
		await close.scrollIntoViewIfNeeded();
		await expect(close).toBeInViewport();
		await expectNoHorizontalOverflow(page);
		await close.click();
		await expect(dialog).toHaveCount(0);
	}
});

test("new recovery digests and reconnects invalidate delayed reads", async ({ join, page, seed }) => {
	await seed("# Shared document\n\nCurrent human prose.\n");
	let wire = await recoveryWire(page);
	await join("ana");
	wire.send([first]);
	await page.getByRole("button", { name: "Recovered edits (1)", exact: true }).click();
	let dialog = page.getByRole("dialog", { name: "Recovered edits", exact: true });
	wire.hold(true);
	await dialog.getByRole("button", { name: first.preview, exact: true }).click();
	await expect.poll(() => wire.reads.length).toBe(1);
	wire.send([updated]);
	wire.reply(wire.reads[0]!, "Stale saved text must never appear.");
	await expect(dialog.getByRole("button", { name: updated.preview, exact: true })).toBeVisible();
	await expect(dialog.getByRole("region", { name: "Saved human text" })).toHaveCount(0);
	await dialog.getByRole("button", { name: updated.preview, exact: true }).click();
	await expect.poll(() => wire.reads.length).toBe(2);
	let connections = wire.routes.length;
	await wire.routes.at(-1)!.close();
	await expect.poll(() => wire.routes.length).toBeGreaterThan(connections);
	await ready(page);
	await expect(dialog).toHaveCount(0);
	await expect(page.getByRole("button", { name: /^Recovered edits/ })).toHaveCount(0);
	wire.reply(wire.reads[1]!, "A previous connection must never reopen saved text.");
	wire.send([updated]);
	await page.getByRole("button", { name: "Recovered edits (1)", exact: true }).click();
	await expect(dialog.getByRole("region", { name: "Saved human text" })).toHaveCount(0);
	wire.hold(false);
	await dialog.getByRole("button", { name: updated.preview, exact: true }).click();
	await expect(dialog.getByRole("region", { name: "Saved human text" })).toHaveText(saved);
	await expect(dialog).not.toContainText("Stale saved text");
	await expect(dialog).not.toContainText("previous connection");
});

test("an old resolve reply cannot erase a newer saved version", async ({ join, page, seed }) => {
	await seed("# Shared document\n\nCurrent human prose.\n");
	let wire = await recoveryWire(page);
	await join("ana");
	wire.send([first]);
	let trigger = page.getByRole("button", { name: "Recovered edits (1)", exact: true });
	await trigger.click();
	let dialog = page.getByRole("dialog", { name: "Recovered edits", exact: true });
	await dialog.getByRole("button", { name: first.preview, exact: true }).click();
	await expect(dialog.getByRole("region", { name: "Saved human text" })).toHaveText(saved);
	wire.holdResolve(true);
	await dialog.getByRole("button", { name: "Add to document", exact: true }).click();
	await expect.poll(() => wire.resolutions.length).toBe(1);
	wire.send([updated]);
	await expect(dialog.getByRole("button", { name: updated.preview, exact: true })).toBeVisible();
	wire.send([], wire.resolutions[0]!.rid);
	await expect(trigger).toBeVisible();
	await expect(dialog.getByRole("button", { name: updated.preview, exact: true })).toBeVisible();
	await expect(dialog.getByRole("region", { name: "Saved human text" })).toHaveCount(0);
});

test(
	"a compact reader can view and copy saved text without writer actions or overflow",
	async ({ baseURL, room, page, seed }, info) => {
		await seed("# Shared document\n\nCurrent human prose.\n");
		await page.setViewportSize({ width: 390, height: 844 });
		let wire = await recoveryWire(page);
		await authenticate(page, "readonly", baseURL!);
		await page.goto(roomPath(room));
		await expect(content(page)).toContainText("Current human prose.");
		await expect(content(page)).toHaveAttribute("contenteditable", "false");
		await page.getByRole("navigation", { name: "Workspace view", exact: true })
			.getByRole("button", { name: /^Document/ }).click();
		wire.send([first]);
		await page.getByRole("button", { name: "Recovered edits (1)", exact: true }).click();
		let dialog = page.getByRole("dialog", { name: "Recovered edits", exact: true });
		await dialog.getByRole("button", { name: first.preview, exact: true }).click();
		await expect(dialog.getByRole("region", { name: "Saved human text" })).toHaveText(saved);
		await expect(dialog.getByRole("button", { name: "Add to document", exact: true })).toHaveCount(
			0,
		);
		await expect(dialog.getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
		await expectNoHorizontalOverflow(page);
		await page.screenshot({
			path: info.outputPath("recovered-edits-reader-phone.png"),
			fullPage: true,
		});
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		expect(wire.resolutions).toHaveLength(0);
	},
);
