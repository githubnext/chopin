/**
 * Bytes on the wire for the frames a person waits on.
 *
 * Opening a large document sends its whole Yjs state (and Chat sends its history) in one frame.
 * On a 20 Mbit/s connection a megabyte of it is close to half a second, and deflate takes it to
 * about a sixth. These count what the socket actually carries, read from a raw connection, so a
 * change that sends the frames uncompressed again fails here rather than only on a slow network.
 */

import { afterEach, expect, test } from "bun:test";
import * as Y from "yjs";

import { COMPRESS_FROM, DEFLATE, reply, tell } from "./wire";

import type { Server, ServerWebSocket } from "bun";

let servers: Server<undefined>[] = [];

afterEach(async () => {
	for (let server of servers) await server.stop(true);
	servers = [];
});

/** A document's state as `plan:open` sends it: base64 of a Yjs update with real prose. */
function documentState(): string {
	let doc = new Y.Doc();
	// A fixed client keeps the size the same from run to run.
	doc.clientID = 1;
	let root = doc.getXmlFragment("root");
	for (let i = 0; i < 400; i++) {
		let paragraph = new Y.XmlElement("paragraph");
		paragraph.insert(0, [
			new Y.XmlText(
				`Step ${i}: the session store renews each lease every few seconds, and the router `
					+ `keeps the cache keys until the gateway forwards request ${i * 7}.`,
			),
		]);
		root.insert(root.length, [paragraph]);
	}
	return Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
}

/** Sends one large reply and one small notice to whoever connects. */
function serve(): Server<undefined> {
	let update = documentState();
	let server = Bun.serve<undefined>({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, self) {
			if (self.upgrade(request)) return undefined;
			return new Response("plain");
		},
		websocket: {
			perMessageDeflate: DEFLATE,
			open(ws: ServerWebSocket<undefined>) {
				reply(ws, "r1", { kind: "plan:open", ts: 0, update } as never);
				tell(ws, { kind: "chat:typing", ts: 0, active: true } as never);
			},
			message() {},
		},
	});
	servers.push(server);
	return server;
}

type Received = { compressed: boolean; bytes: number };

/**
 * Connects over a plain TCP socket and reads the first two frames' headers, so what is counted
 * is the payload as sent, before any decompression.
 */
async function frames(server: Server<undefined>, deflate: boolean): Promise<Received[]> {
	let buffer = Buffer.alloc(0);
	let { promise, resolve, reject } = Promise.withResolvers<Received[]>();
	let socket = await Bun.connect({
		hostname: "127.0.0.1",
		port: server.port!,
		socket: {
			data(_socket, chunk) {
				buffer = Buffer.concat([buffer, chunk]);
				let end = buffer.indexOf("\r\n\r\n");
				if (end < 0) return;
				let found: Received[] = [];
				let at = end + 4;
				while (found.length < 2 && at + 2 <= buffer.length) {
					let compressed = (buffer[at]! & 0x40) !== 0;
					let length = buffer[at + 1]! & 0x7f;
					let header = 2;
					if (length === 126) {
						length = buffer.readUInt16BE(at + 2);
						header = 4;
					} else if (length === 127) {
						length = Number(buffer.readBigUInt64BE(at + 2));
						header = 10;
					}
					if (at + header + length > buffer.length) return;
					found.push({ compressed, bytes: length });
					at += header + length;
				}
				if (found.length === 2) resolve(found);
			},
			error(_socket, error) {
				reject(error);
			},
		},
	});
	socket.write(
		"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
			+ "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
			+ (deflate ? "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n" : "")
			+ "\r\n",
	);
	let result = await promise;
	socket.end();
	return result;
}

test("a document's state goes out deflated to a client that offers it", async () => {
	let server = serve();
	let size = documentState().length;
	expect(size).toBeGreaterThan(50_000);

	let [open, typing] = await frames(server, true);
	expect(open!.compressed).toBe(true);
	// Measured at a sixth for a large document; a quarter leaves room for other prose.
	expect(open!.bytes).toBeLessThan(size / 4);
	// A frame this small is sent as it is: deflate would cost more than it saves.
	expect(typing!.compressed).toBe(false);
	expect(typing!.bytes).toBeLessThan(COMPRESS_FROM);
});

test("a client that does not offer deflate gets the same frames uncompressed", async () => {
	let server = serve();
	let [open, typing] = await frames(server, false);
	expect(open!.compressed).toBe(false);
	expect(open!.bytes).toBeGreaterThan(documentState().length);
	expect(typing!.compressed).toBe(false);
});
