import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

let namespace = "chopin-local-preview-example";
let observations = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page, context }) => {
	let problems: string[] = [];
	observations.set(page, problems);
	function observe(observed: Page) {
		observed.on("pageerror", (error) => {
			if (!error.message.includes("Injected actual")) problems.push(error.message);
		});
		observed.on("console", (message) => {
			if (message.type() === "error" && !message.text().includes("Injected actual")) {
				problems.push(message.text());
			}
		});
		observed.on("requestfailed", (request) => problems.push(request.url()));
		observed.on("request", (request) => {
			if (!/^http:\/\/127\.0\.0\.1:881[01]\//.test(request.url())) problems.push(request.url());
		});
		observed.on("response", (response) => {
			if (response.status() >= 400) problems.push(response.url());
		});
	}
	observe(page);
	context.on("page", observe);
});
test.afterEach(async ({ page }) => {
	expect(observations.get(page), "Unexpected browser errors or resource/network requests").toEqual(
		[],
	);
});
function preview(page: Page) {
	return page.frames().find((frame) => frame.url().includes("/preview.html"))!;
}
async function open(page: Page) {
	await page.goto("/");
	await expect(page.frameLocator("iframe").getByRole("article")).toHaveCSS("padding", "24px");
}
async function spacing(page: Page, value: number) {
	await page.getByRole("spinbutton", { name: "Spacing px", exact: true }).fill(String(value));
	await expect(page.frameLocator("iframe").getByRole("article")).toHaveCSS("padding", `${value}px`);
}

async function retry(page: Page, value: number) {
	let previous = await page.locator("iframe").getAttribute("src");
	let navigation = page.waitForEvent("framenavigated", {
		predicate: (frame) => frame.url().includes("/preview.html?") && frame.url() !== previous,
		timeout: 30_000,
	});
	await page.getByRole("button", { name: "Retry preview", exact: true }).click();
	await navigation;
	await expect(page.frameLocator("iframe").getByRole("article")).toHaveCSS(
		"padding",
		`${value}px`,
		{ timeout: 30_000 },
	);
	await expect(page.getByRole("alert")).toBeHidden();
}

test(
	"source and embedded baseline match; real children, assets, portal and responsive layout",
	async ({ page, context }, info) => {
		await open(page);
		let frame = preview(page);
		await frame.evaluate(() => document.fonts.ready);
		await page.screenshot({
			path: info.outputPath("baseline.png"),
			fullPage: true,
		});
		let size = await page.locator("iframe").evaluate((element) => ({
			width: element.clientWidth,
			height: element.clientHeight,
		}));
		let source = await context.newPage();
		await source.setViewportSize(size);
		await source.goto("http://127.0.0.1:8811/fixture-app/index.html");
		await source.evaluate(() => document.fonts.ready);
		let reference = await source.getByRole("article").screenshot();
		let path = info.snapshotPath("source.png");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, reference);
		// Live source is the oracle at the identical iframe viewport. Zero differing
		// pixels above Playwright's 0.1 perceptual threshold; no checked-in platform golden.
		expect(await frame.getByRole("article").screenshot()).toMatchSnapshot("source.png", {
			threshold: 0.1,
			maxDiffPixels: 0,
		});
		await expect(frame.getByText("Unlimited projects", { exact: true })).toBeVisible();
		await expect(frame.getByText("$24", { exact: true })).toBeVisible();
		expect(
			await frame.evaluate(() =>
				Array.from(document.fonts).some((font) =>
					font.family.includes("Inter Variable") && font.status === "loaded"
				)
			),
		).toBe(true);
		expect(
			await frame.locator("img").evaluate((image: HTMLImageElement) =>
				image.complete && image.naturalWidth > 0
			),
		).toBe(true);
		await frame.getByRole("button", { name: "Manage plan", exact: true }).click();
		await expect(frame.getByRole("heading", { name: "Studio plan", exact: true }))
			.toBeVisible();
		expect(await frame.locator(".billing-popup").evaluate((element) => !element.closest("article")))
			.toBe(true);
		await frame.getByRole("button", { name: "Done", exact: true }).click();
		await spacing(page, 32);
		await page.getByLabel("Accent", { exact: true }).fill("#9f5142");
		await expect(frame.getByRole("button", { name: "Manage plan", exact: true })).toHaveCSS(
			"background-color",
			"rgb(159, 81, 66)",
		);
		await page.screenshot({
			path: info.outputPath("adjusted.png"),
			fullPage: true,
		});
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		expect(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true,
		);
		if (info.project.name === "narrow") {
			let stage = await page.locator("iframe").boundingBox();
			let controls = await page.getByRole("heading", { name: "Adjust", exact: true }).boundingBox();
			expect(controls!.y).toBeGreaterThan(stage!.y + stage!.height);
		}
		expect(
			await frame.evaluate(() => {
				let denied = 0;
				try {
					void parent.document.body;
				} catch {
					denied++;
				}
				try {
					void parent.localStorage.length;
				} catch {
					denied++;
				}
				return denied;
			}),
		).toBe(2);
	},
);

test(
	"range and number synchronize; peek releases preserve chosen exports; Reset",
	async ({ page, context }) => {
		await open(page);
		let slider = page.getByRole("slider", { name: "Spacing slider", exact: true });
		await slider.focus();
		await page.keyboard.press("ArrowRight");
		await expect(page.getByRole("spinbutton", { name: "Spacing px", exact: true })).toHaveValue(
			"25",
		);
		await spacing(page, 32);
		await expect(slider).toHaveValue("32");
		let peek = page.getByRole("button", { name: "Show current", exact: true });
		let card = page.frameLocator("iframe").getByRole("article");
		await peek.focus();
		await page.keyboard.down("Space");
		await expect(peek).toHaveAttribute("aria-pressed", "true");
		await expect(card).toHaveCSS("padding", "24px");
		await page.keyboard.press("a");
		await expect(peek).toHaveAttribute("aria-pressed", "true");
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		// Programmatic click avoids moving focus, so export occurs while Space is held.
		await page.getByRole("button", { name: "Copy values", exact: true }).evaluate((
			element: HTMLButtonElement,
		) => element.click());
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(
			'"spacing": 32',
		);
		let download = page.waitForEvent("download");
		await page.getByRole("button", { name: "Download values", exact: true }).evaluate((
			element: HTMLButtonElement,
		) => element.click());
		expect(JSON.parse(await readFile((await (await download).path())!, "utf8"))).toEqual({
			spacing: 32,
			accent: "#476b55",
		});
		await page.keyboard.up("Space");
		await expect(card).toHaveCSS("padding", "32px");
		for (let event of ["pointercancel", "lostpointercapture"]) {
			await peek.hover();
			await page.mouse.down();
			await expect(card).toHaveCSS("padding", "24px");
			if (event === "lostpointercapture") {
				// A move activates pending capture before release can produce capture loss.
				await peek.hover({ position: { x: 1, y: 1 } });
				await peek.evaluate((element) => element.releasePointerCapture(1));
				await page.mouse.move(0, 0);
			} else await peek.dispatchEvent(event, { pointerId: 1 });
			await expect(card).toHaveCSS("padding", "32px");
			await expect(peek).toHaveAttribute("aria-pressed", "false");
			await page.mouse.up();
		}
		await peek.focus();
		await page.keyboard.down("Space");
		await page.getByRole("button", { name: "Reset", exact: true }).focus();
		await expect(card).toHaveCSS("padding", "32px");
		await page.keyboard.up("Space");
		await peek.hover();
		await page.mouse.down();
		await expect(card).toHaveCSS("padding", "24px");
		await page.mouse.up();
		await expect(card).toHaveCSS("padding", "32px");
		await page.getByRole("button", { name: "Reset", exact: true }).click();
		await expect(card).toHaveCSS("padding", "24px");
		await expect(slider).toHaveValue("24");
		await page.getByRole("button", { name: "Narrow layout", exact: true }).click();
		expect((await page.locator("iframe").boundingBox())!.width).toBeLessThanOrEqual(360);
		await spacing(page, 32);
		let session = await context.newCDPSession(page);
		await peek.scrollIntoViewIfNeeded();
		let bounds = (await peek.boundingBox())!;
		await session.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }],
		});
		await expect(card).toHaveCSS("padding", "24px");
		await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
		await expect(card).toHaveCSS("padding", "32px");
		await peek.focus();
		await page.keyboard.down("Space");
		await page.evaluate(() => window.dispatchEvent(new Event("blur")));
		await expect(card).toHaveCSS("padding", "32px");
		await page.keyboard.up("Space");
	},
);

test("malformed snapshots, wrong window and stale replies cannot alter chosen state", async ({ page }) => {
	await open(page);
	await spacing(page, 32);
	let rejected = await page.evaluate((namespace) =>
		new Promise<boolean[]>((resolve) => {
			let frame = document.querySelector("iframe")!;
			let replies: boolean[] = [];
			let receive = (event: MessageEvent) => {
				if (event.source !== frame.contentWindow || event.data?.id !== 999) return;
				replies.push(event.data.ok);
				if (replies.length === 4) {
					window.removeEventListener("message", receive);
					resolve(replies);
				}
			};
			window.addEventListener("message", receive);
			for (
				let values of [{ spacing: 99, accent: "#476b55" }, { spacing: "32", accent: "#476b55" }, {
					spacing: 24,
					accent: "red",
				}, { spacing: 24, accent: "#476b55", extra: true }]
			) {
				frame.contentWindow!.postMessage({ namespace, type: "apply", id: 999, values }, "*");
			}
			window.postMessage(
				{ namespace, type: "result", id: 3, ok: false, error: "Wrong window" },
				"*",
			);
		}), namespace);
	expect(rejected).toEqual([false, false, false, false]);
	await page.evaluate((namespace) =>
		new Promise<void>((resolve) => {
			let other = document.createElement("iframe");
			other.hidden = true;
			other.sandbox.add("allow-scripts");
			let receive = (event: MessageEvent) => {
				if (event.source === other.contentWindow && event.data === "wrong-window-sent") {
					window.removeEventListener("message", receive);
					other.remove();
					resolve();
				}
			};
			window.addEventListener("message", receive);
			other.srcdoc =
				`<script>parent.postMessage({namespace:${
					JSON.stringify(namespace)
				},type:"result",id:3,ok:false,error:"Wrong window"},"*");parent.postMessage("wrong-window-sent","*")<`
				+ "/script>";
			document.body.append(other);
		}), namespace);
	await preview(page).evaluate(
		(namespace) =>
			parent.postMessage(
				{ namespace, type: "result", id: -1, ok: false, error: "Stale result" },
				"*",
			),
		namespace,
	);
	await expect(page.frameLocator("iframe").getByRole("article")).toHaveCSS("padding", "32px");
	await expect(page.getByRole("alert")).toBeHidden();
	await expect(page.getByRole("spinbutton", { name: "Spacing px", exact: true })).toHaveValue("32");
});

test("actual React commit failure and later portal failure recover last requested values", async ({ page }) => {
	await open(page);
	await preview(page).evaluate(() => {
		let original = CSSStyleDeclaration.prototype.setProperty;
		CSSStyleDeclaration.prototype.setProperty = function(name, value, priority) {
			if (name === "--card-spacing" && value === "33px") {
				CSSStyleDeclaration.prototype.setProperty = original;
				throw new Error("Injected actual card style update failure");
			}
			return original.call(this, name, value, priority);
		};
	});
	await page.getByRole("spinbutton", { name: "Spacing px", exact: true }).fill("33");
	await expect(page.getByRole("alert")).toContainText("Injected actual card style update failure");
	await expect(page.getByRole("spinbutton", { name: "Spacing px", exact: true })).toHaveValue("33");
	await retry(page, 33);
	await preview(page).evaluate(() => {
		let original = Node.prototype.appendChild;
		Node.prototype.appendChild = function<T extends Node>(child: T): T {
			if (child instanceof HTMLElement && child.classList.contains("billing-popup")) {
				Node.prototype.appendChild = original;
				throw new Error("Injected actual portal DOM commit failure");
			}
			return original.call(this, child) as T;
		};
	});
	await preview(page).getByRole("button", { name: "Manage plan", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Injected actual portal DOM commit failure");
	await retry(page, 33);
	await preview(page).getByRole("button", { name: "Manage plan", exact: true }).click();
	await expect(preview(page).getByRole("heading", { name: "Studio plan", exact: true }))
		.toBeVisible();
});

test("missing handshake and self-navigation expose Retry without losing choices", async ({ page }) => {
	await page.route(
		"**/preview.html?*",
		(route) =>
			route.fulfill({
				contentType: "text/html",
				body: "<!doctype html><title>No handshake</title>",
			}),
	);
	await page.goto("/");
	await page.getByRole("spinbutton", { name: "Spacing px", exact: true }).fill("31");
	await expect(page.getByRole("alert")).toContainText("could not load", { timeout: 7000 });
	await page.unroute("**/preview.html?*");
	await retry(page, 31);
	await preview(page).evaluate(() => {
		location.href = "about:blank";
	});
	await expect(page.getByRole("alert")).toContainText("navigated away");
	await retry(page, 31);
});

test("static resource manifest is exact and every digest matches served bytes", async ({ request }) => {
	let output = join(import.meta.dir, ".built");
	let manifest = await (await request.get("http://127.0.0.1:8811/resources.json")).json() as {
		files: { path: string; sha256: string }[];
	};
	let files = await readdir(output, { recursive: true, withFileTypes: true });
	expect(manifest.files.map((file) => file.path).sort()).toEqual(
		files.filter((file) => file.isFile() && file.name !== "resources.json").map((file) =>
			join(file.parentPath, file.name).slice(output.length + 1)
		).sort(),
	);
	for (let file of manifest.files) {
		let response = await request.get(`http://127.0.0.1:8811/${file.path}`);
		expect(response.ok()).toBe(true);
		expect(createHash("sha256").update(await response.body()).digest("hex")).toBe(file.sha256);
	}
	expect(manifest.files.some((file) => file.path.endsWith(".woff2"))).toBe(true);
	expect(manifest.files.some((file) => file.path.endsWith(".svg"))).toBe(true);
});
