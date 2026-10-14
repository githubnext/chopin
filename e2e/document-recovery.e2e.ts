import * as Service from "../apps/server/src/plan/service";
import * as document from "../apps/server/src/plan/room";
import { reconcile } from "../apps/server/src/document-development/reconcile";
import {
	clientPeer,
	fixture,
	request,
	submitClientUpdate,
} from "../apps/server/src/document-development/provenance.test-fixtures";
import { recoveryConflicts } from "../apps/server/src/document-development/recovery-actions";
import { authenticate, content, expect, ready, roomPath, test, written } from "./room";

const FIRST = "A collaborator kept these initial words.";
const LATER = "A collaborator continued editing the earlier version.";

/** Seed an actual retained version across an epoch, as a checkpoint rebuild would preserve it. */
async function recoveryFixture() {
	let context = await fixture();
	let peer = await clientPeer(context.plan);
	try {
		await reconcile(context.plan, request(context.plan), () => true);
		await submitClientUpdate(context.plan, await peer.update({ index: 1, text: FIRST }));
		await submitClientUpdate(context.plan, await peer.update({ index: 1, text: LATER }));
		let conflict = recoveryConflicts(context.plan)[0]!;
		return {
			source: document.project(context.plan.document),
			state: structuredClone(context.plan.documentDevelopment!),
			conflict,
		};
	} finally {
		peer.destroy();
		await Service.close(context.plan);
	}
}

test(
	"retained human edits remain readable and resolvable with automatic drafting disabled",
	async ({
		baseURL,
		browser,
		join,
		room,
		seed,
	}, info) => {
		let saved = await recoveryFixture();
		await seed(saved.source, { documentDevelopment: saved.state });
		let writer = await join("ana");
		await expect(writer.getByRole("group", { name: "Document draft updates", exact: true }))
			.toHaveCount(0);
		await writer.getByRole("button", { name: "Recovered edits (1)", exact: true }).click();
		let dialog = writer.getByRole("dialog", { name: "Recovered edits", exact: true });
		await dialog.getByRole("button", {
			name: saved.conflict.source.slice(0, 200).trim(),
			exact: true,
		})
			.click();
		await expect(dialog.getByRole("region", { name: "Saved human text", exact: true }))
			.toContainText(LATER);
		await writer.screenshot({
			path: info.outputPath("document-recovered-edits.png"),
			fullPage: true,
		});

		let readerContext = await browser.newContext({ baseURL });
		try {
			let reader = await readerContext.newPage();
			await authenticate(reader, "readonly", baseURL!);
			await reader.goto(roomPath(room));
			await expect(content(reader)).toHaveAttribute("contenteditable", "false");
			await reader.getByRole("button", { name: "Recovered edits (1)", exact: true }).click();
			let readerDialog = reader.getByRole("dialog", { name: "Recovered edits", exact: true });
			await readerDialog.getByRole("button", {
				name: saved.conflict.source.slice(0, 200).trim(),
				exact: true,
			})
				.click();
			await expect(readerDialog.getByRole("region", { name: "Saved human text", exact: true }))
				.toContainText(LATER);
			await expect(readerDialog.getByRole("button", { name: "Add to document", exact: true }))
				.toHaveCount(0);
			let response = await reader.evaluate(async ({ room, conflict }) => {
				let url = new URL("/ws", location.href);
				url.protocol = "ws:";
				url.searchParams.set("channel", room);
				let socket = new WebSocket(url);
				try {
					return await new Promise<{ kind: string; message?: string }>((resolve, reject) => {
						let rid = crypto.randomUUID();
						let timeout = setTimeout(() => reject(new Error("recovery request timed out")), 10_000);
						socket.addEventListener("message", event => {
							let frame = JSON.parse(String(event.data));
							if (frame.kind === "session:hello") {
								socket.send(JSON.stringify({
									kind: "document-development:recovery-resolve",
									ts: 0,
									rid,
									id: conflict.id,
									digest: conflict.digest,
									action: "dismiss",
								}));
							}
							if (frame.rid === rid) {
								clearTimeout(timeout);
								resolve(frame);
							}
						});
					});
				} finally {
					socket.close();
				}
			}, { room, conflict: saved.conflict });
			expect(response.kind).toBe("session:error");
			expect(response.message).toContain("write access");

			await dialog.getByRole("button", { name: "Add to document", exact: true }).click();
			await written(writer, room, LATER);
			await expect(content(reader)).toContainText(LATER);
			await expect(content(writer)).toContainText(FIRST);
			await expect(writer.getByRole("button", { name: "Recovered edits (1)", exact: true }))
				.toHaveCount(0);
			await writer.reload();
			await ready(writer);
			await expect(content(writer)).toContainText(LATER);
			await expect(content(writer)).toContainText(FIRST);
			await expect(writer.getByRole("button", { name: /^Recovered edits/ })).toHaveCount(0);
		} finally {
			await readerContext.close();
		}
	},
);
