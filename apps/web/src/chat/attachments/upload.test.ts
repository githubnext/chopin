import { describe, expect, it } from "bun:test";

import { discardUpload, inspectFile, UploadError, uploadFile } from "./upload";

import type { UploadRequest } from "./upload";

const LIMITS = { maxBytes: 64, maxCount: 2, maxTotalBytes: 96 };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

function fileOf(bytes: Uint8Array | string, name: string, type = ""): File {
	return new File([bytes as BlobPart], name, { type });
}

/** A stand-in for the browser's request that answers when the test says so. */
class FakeRequest implements UploadRequest {
	status = 0;
	responseText = "";
	#progress: Array<(event: ProgressEvent) => void> = [];
	#events: Record<string, Array<() => void>> = { load: [], error: [], abort: [] };
	upload = {
		addEventListener: (_type: "progress", listener: (event: ProgressEvent) => void) => {
			this.#progress.push(listener);
		},
	};
	addEventListener(type: "load" | "error" | "abort", listener: () => void) {
		this.#events[type]!.push(listener);
	}
	fire(type: "load" | "error" | "abort") {
		for (let listener of this.#events[type]!) listener();
	}
	opened: [string, string | URL] | undefined;
	headers: Record<string, string> = {};
	sent: unknown;
	aborted = false;
	open(method: string, url: string | URL) {
		this.opened = [method, url];
	}
	setRequestHeader(name: string, value: string) {
		this.headers[name] = value;
	}
	send(body?: Document | XMLHttpRequestBodyInit | null) {
		this.sent = body;
	}
	abort() {
		this.aborted = true;
		this.fire("abort");
	}
	progress(loaded: number, total: number) {
		for (let listener of this.#progress) {
			listener({ lengthComputable: true, loaded, total } as ProgressEvent);
		}
	}
	answer(status: number, body: unknown) {
		this.status = status;
		this.responseText = typeof body === "string" ? body : JSON.stringify(body);
		this.fire("load");
	}
}

describe("checking a file before it is uploaded", () => {
	it("reads what the bytes are, whatever the name says", async () => {
		expect(await inspectFile(fileOf(PNG, "notes.txt", "text/plain"), LIMITS)).toEqual({
			ok: true,
			kind: "image",
			mimeType: "image/png",
		});
		expect(await inspectFile(fileOf("# Notes\n", "notes.md", "text/markdown"), LIMITS)).toEqual({
			ok: true,
			kind: "file",
			mimeType: "text/plain",
		});
	});

	it("refuses with the reason in words, and never reads a file over the cap", async () => {
		expect(await inspectFile(fileOf("a".repeat(65), "big.txt"), LIMITS)).toEqual({
			ok: false,
			refusal: "too-large",
			message: "big.txt is over the 64 B limit for a file.",
		});
		expect(await inspectFile(fileOf("a".repeat(64), "cap.txt"), LIMITS)).toMatchObject({
			ok: true,
		});
		expect(await inspectFile(fileOf("", "empty.txt"), LIMITS)).toMatchObject({
			ok: false,
			refusal: "empty",
		});
		expect(await inspectFile(fileOf("<svg><script/></svg>", "logo.svg", "image/svg+xml"), LIMITS))
			.toEqual({
				ok: false,
				refusal: "image-type",
				message: "logo.svg isn't a PNG, JPEG, WebP or GIF image.",
			});
		expect(await inspectFile(fileOf(new Uint8Array([0x50, 0x4b, 3, 4, 0]), "a.zip"), LIMITS))
			.toMatchObject({ ok: false, refusal: "unsupported" });
	});
});

describe("uploading a file", () => {
	let sent = {
		id: "s1",
		name: "shot.png",
		kind: "image",
		mimeType: "image/png",
		size: 11,
	} as const;

	it("sends its bytes to the document's files with its name and type, reports progress and gets the file back", async () => {
		let request = new FakeRequest();
		let progress: number[] = [];
		let file = fileOf(PNG, "my shot.png", "image/png");
		let done = uploadFile({
			channelId: "ch 1",
			file,
			name: "my shot.png",
			onProgress: percent => progress.push(percent),
			request: () => request,
		});
		expect(request.opened).toEqual([
			"POST",
			"/api/channels/ch%201/attachments?name=my%20shot.png&type=image%2Fpng",
		]);
		expect(request.headers).toEqual({ "content-type": "application/octet-stream" });
		expect(request.sent).toBe(file);
		request.progress(5, 10);
		request.progress(10, 10);
		request.answer(201, { attachment: sent });
		expect(await done).toEqual(sent);
		expect(progress).toEqual([50, 100]);
	});

	it("is refused with the server's own words and no retry, for it would say the same again", async () => {
		let request = new FakeRequest();
		let done = uploadFile({
			channelId: "c",
			file: fileOf("x", "a.txt"),
			name: "a.txt",
			request: () => request,
		});
		request.answer(413, { error: "a.txt is over the 1 MB limit for a file.", reason: "too-large" });
		let error = await done.catch(value => value);
		expect(error).toBeInstanceOf(UploadError);
		expect(error).toMatchObject({
			refusal: "too-large",
			message: "a.txt is over the 1 MB limit for a file.",
			retry: false,
		});
	});

	it("may be tried again when it never got through, or the server was in trouble", async () => {
		for (let attempt of ["network", 503, 502] as const) {
			let request = new FakeRequest();
			let done = uploadFile({
				channelId: "c",
				file: fileOf("x", "a.txt"),
				name: "a.txt",
				request: () => request,
			});
			if (attempt === "network") request.fire("error");
			else request.answer(attempt, "<html>Bad gateway</html>");
			let error = await done.catch(value => value);
			expect(error, String(attempt)).toMatchObject({
				refusal: "upload-failed",
				message: "a.txt didn't upload.",
				retry: true,
			});
		}
		let request = new FakeRequest();
		let done = uploadFile({
			channelId: "c",
			file: fileOf("x", "a.txt"),
			name: "a.txt",
			request: () => request,
		});
		request.answer(404, "gone");
		expect(await done.catch(value => value)).toMatchObject({ retry: false });
	});

	it("stops when asked to, and does not start when it was asked to already", async () => {
		let request = new FakeRequest();
		let controller = new AbortController();
		let done = uploadFile({
			channelId: "c",
			file: fileOf("x", "a.txt"),
			name: "a.txt",
			signal: controller.signal,
			request: () => request,
		});
		controller.abort();
		expect(request.aborted).toBe(true);
		expect(await done.catch(value => value)).toMatchObject({
			message: "The upload was stopped.",
			retry: false,
		});
		let early = new FakeRequest();
		let stopped = new AbortController();
		stopped.abort();
		let never = uploadFile({
			channelId: "c",
			file: fileOf("x", "a.txt"),
			name: "a.txt",
			signal: stopped.signal,
			request: () => early,
		});
		expect(early.aborted).toBe(true);
		expect(early.sent).toBeUndefined();
		await never.catch(() => {});
	});
});

describe("taking an upload back", () => {
	it("asks the server to forget it, and says nothing if it cannot", async () => {
		let asked: Array<[string, string | undefined]> = [];
		await discardUpload(
			"ch",
			"a/b",
			(async (url: string, init?: RequestInit) => {
				asked.push([url, init?.method]);
				return new Response(null, { status: 204 });
			}) as unknown as typeof fetch,
		);
		expect(asked).toEqual([["/api/channels/ch/attachments/a%2Fb", "DELETE"]]);
		await discardUpload(
			"ch",
			"x",
			(async () => {
				throw new TypeError("offline");
			}) as unknown as typeof fetch,
		);
	});
});
