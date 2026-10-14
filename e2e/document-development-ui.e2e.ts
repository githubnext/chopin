import { authenticate, content, expect, roomPath, test } from "./room";
import { expectNoHorizontalOverflow } from "./responsive";

import type { DocumentDevelopment } from "../packages/protocol/index";
import type { Page, WebSocketRoute } from "@playwright/test";

/** Exercise the browser adapter while the ordinary E2E server keeps model work disabled. */
async function draftWire(page: Page, readOnly = false) {
	let routes: WebSocketRoute[] = [];
	let controls: { paused: boolean; rid: string }[] = [];
	let state: DocumentDevelopment.State = {
		kind: "document-development:state",
		ts: 0,
		paused: false,
		pending: false,
		generated: 2,
		protected: 1,
	};
	let hold = false;
	await page.routeWebSocket("**/ws?**", route => {
		routes.push(route);
		let server = route.connectToServer();
		route.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string; paused: boolean; rid: string };
				if (frame.kind === "document-development:control") {
					controls.push({ paused: frame.paused, rid: frame.rid });
					if (!hold) {
						state = { ...state, paused: frame.paused };
						route.send(JSON.stringify({ ...state, rid: frame.rid }));
					}
					return;
				}
			}
			server.send(message);
		});
		server.onMessage(message => {
			if (typeof message === "string") {
				let frame = JSON.parse(message) as { kind: string; canEdit?: boolean; canManage?: boolean };
				if (frame.kind === "document-development:state") return;
				if (readOnly && ["session:hello", "session:access"].includes(frame.kind)) {
					route.send(JSON.stringify({ ...frame, canEdit: false, canManage: false }));
					return;
				}
			}
			route.send(message);
		});
	});
	return {
		controls,
		routes,
		hold: () => {
			hold = true;
		},
		send: (patch: Partial<DocumentDevelopment.State> = {}) => {
			state = { ...state, ...patch };
			routes.at(-1)!.send(JSON.stringify(state));
		},
	};
}

test(
	"draft updates appear only with server state and support keyboard pause, resume and reconnect",
	async ({ join, page, seed }, info) => {
		await seed("# Shared editor\n\nA document for discussing saves.\n");
		let wire = await draftWire(page);
		await join("ana");
		let group = page.getByRole("group", { name: "Document draft updates", exact: true });
		await expect(group).toHaveCount(0);
		wire.send();
		await expect(group.getByRole("status")).toHaveText("Provisional draft");
		let pause = group.getByRole("button", { name: "Pause draft updates", exact: true });
		await pause.focus();
		await page.keyboard.press("Enter");
		await expect(group.getByRole("status")).toHaveText("Draft updates paused");
		await group.getByRole("button", { name: "Resume draft updates", exact: true }).click();
		await expect(group.getByRole("status")).toHaveText("Provisional draft");
		expect(wire.controls.map(control => control.paused)).toEqual([true, false]);
		wire.send({ pending: true });
		await expect(group.getByRole("status")).toHaveText("Updating draft");
		wire.send({ pending: false, lastOutcome: "failed" });
		await expect(group.getByRole("status")).toHaveText("Draft update failed");
		await expect(group.getByRole("button", { name: /Retry/ })).toHaveCount(0);
		await page.screenshot({ path: info.outputPath("document-draft-control.png") });
		wire.hold();
		await pause.click();
		await expect(pause).toBeDisabled();
		let priorConnections = wire.routes.length;
		await wire.routes.at(-1)!.close();
		await expect.poll(() => wire.routes.length).toBeGreaterThan(priorConnections);
		await expect(group).toHaveCount(0);
		wire.send({ paused: true, lastOutcome: "updated" });
		await expect(group.getByRole("status")).toHaveText("Draft updates paused");
		await expect(group.getByRole("button", { name: "Resume draft updates", exact: true }))
			.toBeEnabled();
	},
);

test("a compact reader sees draft state without writer controls or horizontal overflow", async ({ baseURL, room, page, seed }) => {
	await seed("# Shared editor\n\nA document for discussing saves.\n");
	await page.setViewportSize({ width: 390, height: 844 });
	let wire = await draftWire(page, true);
	await authenticate(page, "ana", baseURL!);
	await page.goto(roomPath(room));
	await expect(content(page)).toContainText("A document for discussing saves.");
	await expect(content(page)).toHaveAttribute("contenteditable", "false");
	await page.getByRole("navigation", { name: "Workspace view", exact: true })
		.getByRole("button", { name: /^Document/ }).click();
	wire.send({ paused: true });
	let group = page.getByRole("group", { name: "Document draft updates", exact: true });
	await expect(group.getByRole("status")).toHaveText("Draft updates paused");
	await expect(group.getByRole("button")).toHaveCount(0);
	await expectNoHorizontalOverflow(page);
	await page.getByRole("navigation", { name: "Workspace view", exact: true })
		.getByRole("button", { name: /^Decisions/ }).click();
	await expect(group).toHaveCount(0);
});
