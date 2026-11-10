import { expect, test } from "bun:test";

import { probeExternalRead } from "./image-read";

const URL = "https://pictures.example/a.png";

test("an image's host that lets a page read it is read once, without credentials or a referrer, and not downloaded", async () => {
	let sent: Array<{ url: string; init: RequestInit }> = [];
	let read = await probeExternalRead(URL, async (url, init) => {
		sent.push({ url, init });
		return new Response("bytes");
	});

	expect(read).toBe("readable");
	expect(sent).toHaveLength(1);
	expect(sent[0]!.url).toBe(URL);
	expect(sent[0]!.init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
	expect(sent[0]!.init.method ?? "GET").toBe("GET");
	expect(sent[0]!.init.signal?.aborted).toBe(true);
});

test("an image's host that does not let a page read it, or does not answer in time, is not readable", async () => {
	expect(
		await probeExternalRead(URL, async () => {
			throw new TypeError("Failed to fetch");
		}),
	).toBe("unreadable");

	let silent: RequestInit | undefined;
	expect(
		await probeExternalRead(
			URL,
			(_url, init) => {
				silent = init;
				return new Promise<Response>(() => {});
			},
			20,
		),
	).toBe("unreadable");
	expect(silent?.signal?.aborted).toBe(true);
});
