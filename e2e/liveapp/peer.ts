import type * as Yjs from "../../apps/web/node_modules/yjs";
import { resolve } from "node:path";
import { authenticate } from "../room";
import type { Browser } from "@playwright/test";

type Frame = { kind: string; epoch?: string; update?: string; id?: string };

/** A real admitted product peer, with no application or LiveApp page loaded. */
export async function protocolPeer(browser: Browser, origin: string, room: string) {
	let Y: typeof Yjs = await import(
		Bun.resolveSync("yjs", resolve(import.meta.dir, "../../apps/web"))
	);
	let context = await browser.newContext();
	let page = await context.newPage();
	await authenticate(page, "bea", origin);
	let cookie = (await context.cookies()).map(item => `${item.name}=${item.value}`).join("; ");
	await context.close();
	let url = new URL("/ws", origin);
	url.protocol = "ws:";
	url.searchParams.set("channel", room);
	// Bun's socket supports handshake headers; the DOM declaration omits them.
	let Socket = WebSocket as unknown as new(
		url: URL,
		options: { headers: Record<string, string> },
	) => WebSocket;
	let socket = new Socket(url, { headers: { Cookie: cookie, Origin: origin } });
	let doc = new Y.Doc(), frames: Frame[] = [];
	let listeners = new Set<() => void>();
	socket.addEventListener("message", event => {
		let frame = JSON.parse(String(event.data)) as Frame;
		frames.push(frame);
		if ((frame.kind === "plan:open" || frame.kind === "plan:update") && frame.update) {
			Y.applyUpdate(doc, Buffer.from(frame.update, "base64"));
		}
		for (let listener of listeners) listener();
	});
	let wait = (predicate: (frame: Frame) => boolean) =>
		new Promise<Frame>((resolve, reject) => {
			let timer = setTimeout(() => {
				listeners.delete(check);
				reject(new Error(`Product peer response timed out: ${JSON.stringify(frames.slice(-3))}`));
			}, 15_000);
			let check = () => {
				let found = frames.find(predicate);
				if (found) {
					clearTimeout(timer);
					listeners.delete(check);
					resolve(found);
				}
			};
			listeners.add(check);
			check();
		});
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("Product peer could not connect")), {
			once: true,
		});
	});
	socket.send(JSON.stringify({ kind: "plan:open", rid: crypto.randomUUID(), ts: 0 }));
	let opened = await wait(frame => frame.kind === "plan:open");
	function textNodes(value: Yjs.XmlText): Yjs.XmlText[] {
		return [
			value,
			...value.toDelta().flatMap((part: { insert?: unknown }) =>
				part.insert instanceof Y.XmlText ? textNodes(part.insert) : []
			),
		];
	}
	return {
		epoch: opened.epoch,
		text: () => textNodes(doc.get("root", Y.XmlText)).map(node => node.toString()).join("\n"),
		async append(text: string) {
			let target = textNodes(doc.get("root", Y.XmlText)).find(node =>
				node.toDelta().some((part: { insert?: unknown }) =>
					typeof part.insert === "string" && part.insert.includes("baseline")
				)
			);
			if (!target) throw new Error("No synchronized paragraph on product peer");
			let vector = Y.encodeStateVector(doc);
			target.insert(target.length, text);
			let id = crypto.randomUUID();
			socket.send(
				JSON.stringify({
					kind: "plan:update",
					rid: crypto.randomUUID(),
					id,
					epoch: opened.epoch,
					update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString("base64"),
					ts: 0,
				}),
			);
			await wait(frame => frame.kind === "plan:ack" && frame.id === id);
		},
		close() {
			socket.close();
			doc.destroy();
		},
	};
}
