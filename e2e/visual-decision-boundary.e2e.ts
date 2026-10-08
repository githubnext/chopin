import { createServer } from "node:http";
import { expect, test } from "./room";
import { card, createDecision, openWire, state } from "./visual-decision.helpers";

import type { AddressInfo } from "node:net";

test("actual preview responses isolate credentials/storage and block egress/navigation with recovery", async ({ join, page, room }) => {
	let hits: string[] = [];
	let server = createServer((request, response) => {
		hits.push(request.url ?? "/");
		if (request.url?.startsWith("/image")) {
			response.writeHead(200, { "content-type": "image/svg+xml" });
			response.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
		} else {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<!doctype html><title>Boundary canary</title><button>Navigate</button>");
		}
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	let origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	let navigations: Array<
		{ cookie?: string; authorization?: string; headers: Record<string, string> }
	> = [];
	page.on("response", async response => {
		if (
			!response.url().includes("localhost:8793/bundles/")
			|| !response.request().isNavigationRequest()
		) return;
		let headers = await response.request().allHeaders();
		navigations.push({
			cookie: headers.cookie,
			authorization: headers.authorization,
			headers: await response.allHeaders(),
		});
	});
	try {
		await page.context().addCookies([{
			name: "visual_host_canary",
			value: "private",
			url: "http://127.0.0.1:8788",
		}]);
		let ana = await join("ana");
		let id = await createDecision(ana);
		await openWire(ana, room);
		await expect(card(ana).locator('[data-visual-preview-state="ready"]')).toBeVisible();
		await expect.poll(() => navigations.length).toBeGreaterThan(0);
		for (let navigation of navigations) {
			expect(navigation.cookie).toBeUndefined();
			expect(navigation.authorization).toBeUndefined();
			expect(navigation.headers["set-cookie"]).toBeUndefined();
			expect(navigation.headers["content-security-policy"]).toContain("connect-src 'none'");
			expect(navigation.headers["content-security-policy"]).toContain("sandbox allow-scripts");
			expect(navigation.headers["content-security-policy"]).toContain("img-src data:");
		}
		let iframe = card(ana).locator("iframe");
		await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
		await expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
		let frame = (await iframe.elementHandle())!;
		let child = (await frame.contentFrame())!;
		await ana.evaluate(() => {
			localStorage.setItem("visual_host_canary", "private");
			document.documentElement.setAttribute("data-visual-host-canary", "private");
		});
		let blocked = await child.evaluate(async () => {
			// oxlint-disable-next-line unicorn(consistent-function-scoping) -- This callback runs inside the opaque browser frame.
			let probe = (read: () => unknown) => {
				try {
					read();
					return "allowed";
				} catch (error) {
					return (error as Error).name;
				}
			};
			let indexed = await new Promise<string>(resolve => {
				try {
					let request = indexedDB.open("visual-canary");
					request.addEventListener("error", () => resolve(request.error?.name ?? "error"));
					request.addEventListener("success", () => {
						request.result.close();
						resolve("allowed");
					});
				} catch (error) {
					resolve((error as Error).name);
				}
			});
			let cache: string;
			try {
				await caches.open("visual-canary");
				cache = "allowed";
			} catch (error) {
				cache = (error as Error).name;
			}
			return {
				hostDom: probe(() => parent.document.documentElement.dataset.visualHostCanary),
				hostCookie: probe(() => parent.document.cookie),
				hostStorage: probe(() => parent.localStorage.getItem("visual_host_canary")),
				cookie: probe(() => document.cookie),
				storage: probe(() => localStorage.getItem("visual_host_canary")),
				indexed,
				cache,
			};
		});
		for (let result of Object.values(blocked)) expect(result).toBe("SecurityError");
		let egress = await child.evaluate(async canary => {
			let fetchResult = await fetch(`${canary}/fetch?from=frame`, { mode: "no-cors" }).then(
				() => "allowed",
				() => "blocked",
			);
			let imageResult = await new Promise<string>(resolve => {
				let image = new Image();
				image.addEventListener("load", () => resolve("allowed"));
				image.addEventListener("error", () => resolve("blocked"));
				image.src = `${canary}/image?from=frame`;
			});
			return { fetchResult, imageResult };
		}, origin);
		expect(egress).toEqual({ fetchResult: "blocked", imageResult: "blocked" });
		expect(hits).toEqual([]);
		let originalUrl = ana.url();
		let popupCount = ana.context().pages().length;
		await child.evaluate(canary => {
			let button = document.createElement("button");
			button.textContent = "Boundary navigation probe";
			button.addEventListener("click", () => {
				window.open(`${canary}/popup?from=frame`);
				try {
					top!.location.href = `${canary}/top?from=frame`;
				} catch { /* Expected sandbox denial. */ }
			});
			document.body.append(button);
		}, origin);
		await child.getByRole("button", { name: "Boundary navigation probe", exact: true }).click();
		expect(ana.context().pages()).toHaveLength(popupCount);
		expect(ana.url()).toBe(originalUrl);
		expect(hits).toEqual([]);

		// Reachable unsandboxed browser controls prove the canary is not supplying denial.
		let control = await ana.context().newPage();
		await control.goto(origin);
		expect(
			await control.evaluate(async canary => {
				let response = await fetch(`${canary}/fetch?from=control`, { mode: "no-cors" });
				await new Promise<void>(resolve => {
					let image = new Image();
					image.addEventListener("load", () => resolve());
					image.src = `${canary}/image?from=control`;
				});
				return response.status;
			}, origin),
		).toBe(200);
		await control.getByRole("button", { name: "Navigate", exact: true }).evaluate(
			(element, canary) => {
				element.addEventListener("click", () => window.open(`${canary}/popup?from=control`));
			},
			origin,
		);
		let opened = control.waitForEvent("popup");
		await control.getByRole("button", { name: "Navigate", exact: true }).click();
		let popup = await opened;
		await popup.waitForLoadState();
		await popup.close();
		await control.goto(`${origin}/top?from=control`);
		await control.close();
		expect(hits).toEqual(
			expect.arrayContaining([
				"/fetch?from=control",
				"/image?from=control",
				"/popup?from=control",
				"/top?from=control",
			]),
		);
		expect(hits.filter(hit => hit.includes("from=frame"))).toEqual([]);

		await card(ana).getByRole("textbox", { name: "Selected-option colour", exact: true }).fill(
			"#AABBCC",
		);
		await expect(card(ana).getByRole("button", { name: "Save decision", exact: true }))
			.toBeEnabled();
		let accepted = await state(ana, id);
		await child.evaluate(() => location.reload());
		await expect(card(ana).locator('[data-visual-preview-state="ready"]')).toBeVisible();
		let reloaded = (await (await iframe.elementHandle())!.contentFrame())!;
		await expect(
			reloaded.getByText("How should people sign in to this prototype?", { exact: true }),
		).toBeVisible();
		let replaced = ana.waitForEvent("framedetached", { predicate: value => value === reloaded });
		await reloaded.evaluate(canary => {
			location.href = `${canary}/self?from=frame`;
		}, origin);
		await replaced;
		await expect(card(ana).locator('[data-visual-preview-state="ready"]')).toBeVisible();
		let recovered = (await (await iframe.elementHandle())!.contentFrame())!;
		await expect(
			recovered.getByText("How should people sign in to this prototype?", { exact: true }),
		).toBeVisible();
		expect(
			await recovered.evaluate(() =>
				document.documentElement.style.getPropertyValue("--visual-selected-color")
			),
		).toBe("#AABBCC");
		expect(await state(ana, id)).toEqual(accepted);
		expect(hits.filter(hit => hit.includes("from=frame"))).toEqual([]);
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close(error => error ? reject(error) : resolve())
		);
	}
});
