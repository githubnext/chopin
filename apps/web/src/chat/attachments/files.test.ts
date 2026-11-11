import { describe, expect, it } from "bun:test";

import {
	chipProps,
	filesReducer,
	messageFileProps,
	readiness,
	refusalFor,
	sentIds,
	viewFiles,
} from "./files";

import type { DraftFile } from "./files";

const LIMITS = { maxBytes: 1_000_000, maxCount: 2, maxTotalBytes: 1_500_000 };

function file(id: string, overrides: Partial<DraftFile> = {}): DraftFile {
	return {
		id,
		name: `${id}.png`,
		kind: "image",
		size: 2048,
		mimeType: "image/png",
		status: { type: "running", reason: "uploading", progress: 0 },
		...overrides,
	};
}

const SENT = { id: "s1", name: "a.png", kind: "image" as const, mimeType: "image/png", size: 2048 };

function run(...actions: Parameters<typeof filesReducer>[1][]): readonly DraftFile[] {
	return actions.reduce<readonly DraftFile[]>(filesReducer, []);
}

describe("a file on its way to a message", () => {
	it("is added once, uploads with progress, and completes with the file the server kept", () => {
		let state = run(
			{ type: "add", file: file("a") },
			{ type: "add", file: file("a") },
			{ type: "progress", id: "a", progress: 40 },
		);
		expect(state).toHaveLength(1);
		expect(state[0]!.status).toEqual({ type: "running", reason: "uploading", progress: 40 });
		let done = filesReducer(state, { type: "uploaded", id: "a", sent: SENT });
		expect(done[0]!.status).toEqual({ type: "complete" });
		expect(done[0]!.sent).toEqual(SENT);
		// Progress that arrives after it completed changes nothing.
		expect(filesReducer(done, { type: "progress", id: "a", progress: 90 })).toEqual(done);
	});

	it("takes what its bytes are in place of what its name claimed", () => {
		let state = run({ type: "add", file: file("a", { kind: "file", mimeType: "text/plain" }) }, {
			type: "read",
			id: "a",
			kind: "image",
			mimeType: "image/jpeg",
		});
		expect(state[0]).toMatchObject({ kind: "image", mimeType: "image/jpeg" });
	});

	it("fails with its reason, tries again from nothing, and forgets what the server kept", () => {
		let state = run(
			{ type: "add", file: file("a") },
			{ type: "uploaded", id: "a", sent: SENT },
			{
				type: "failed",
				id: "a",
				refusal: "upload-failed",
				message: "a.png didn't upload.",
				retry: true,
			},
		);
		expect(state[0]!.status).toEqual({
			type: "incomplete",
			reason: "error",
			refusal: "upload-failed",
			message: "a.png didn't upload.",
			retry: true,
		});
		expect(state[0]).not.toHaveProperty("sent");
		let again = filesReducer(state, { type: "retry", id: "a" });
		expect(again[0]!.status).toEqual({ type: "running", reason: "uploading", progress: 0 });
	});

	it("is removed, alone or with every other", () => {
		let state = run({ type: "add", file: file("a") }, { type: "add", file: file("b") });
		expect(filesReducer(state, { type: "remove", id: "a" }).map(value => value.id)).toEqual(["b"]);
		expect(filesReducer(state, { type: "clear" })).toEqual([]);
		let empty: readonly DraftFile[] = [];
		expect(filesReducer(empty, { type: "clear" })).toBe(empty);
	});
});

describe("what the message would come to", () => {
	it("refuses the file that would be one too many, or too much, and counts only what is carried", () => {
		let carried = [
			file("a", { size: 1_000_000, status: { type: "complete" } }),
			file("b", { size: 400_000 }),
		];
		expect(refusalFor(carried, 1, LIMITS)).toEqual({
			refusal: "too-many",
			message: "A message can carry up to 2 files.",
		});
		let one = [file("a", { size: 1_000_000, status: { type: "complete" } })];
		expect(refusalFor(one, 500_000, LIMITS)).toBeUndefined();
		expect(refusalFor(one, 500_001, LIMITS)).toEqual({
			refusal: "too-much",
			message: "The files in a message can total up to 1.4 MB.",
		});
		// A refused file carries nothing, so it does not take the place of one that could be.
		let refused = [
			file("a", {
				size: 900_000,
				status: {
					type: "incomplete",
					reason: "error",
					refusal: "unsupported",
					message: "no",
					retry: false,
				},
			}),
			file("b", { size: 100, status: { type: "complete" } }),
		];
		expect(refusalFor(refused, 1_000_000, LIMITS)).toBeUndefined();
	});
});

describe("how the files are drawn", () => {
	it("shows a running upload as its percent, a complete one as its size, and a failure as its reason", () => {
		let views = viewFiles([
			file("a", { status: { type: "running", reason: "uploading", progress: 41.6 } }),
			file("b", { size: 20_480, status: { type: "complete" }, sent: { ...SENT, id: "s2" } }),
			file("c", {
				status: {
					type: "incomplete",
					reason: "error",
					refusal: "upload-failed",
					message: "c.png didn't upload.",
					retry: true,
				},
			}),
		], { imagesAllowed: true });
		expect(views.map(view => [view.state, view.sizeLabel, view.retry])).toEqual([
			["uploading", "42%", false],
			["done", "20 KB", false],
			["error", "2 KB", true],
		]);
		expect(views[2]!.error).toBe("c.png didn't upload.");
		expect(readiness(views)).toEqual({ uploading: 1, failed: 1, ready: false });
		expect(readiness(views.slice(1, 2))).toEqual({ uploading: 0, failed: 0, ready: true });
		expect(readiness([])).toEqual({ uploading: 0, failed: 0, ready: true });
	});

	it("shows an image as refused where the model cannot read it, with the reason, and fine again where it can", () => {
		let files = [
			file("a", { status: { type: "complete" }, sent: SENT }),
			file("b", {
				kind: "file",
				mimeType: "text/plain",
				name: "b.txt",
				status: { type: "complete" },
			}),
		];
		let blocked = viewFiles(files, { imagesAllowed: false });
		expect(blocked[0]).toMatchObject({
			state: "error",
			retry: false,
			error: "This model can't read images. Send it as text, or to the room.",
		});
		expect(blocked[1]!.state).toBe("done");
		expect(readiness(blocked).ready).toBe(false);
		expect(viewFiles(files, { imagesAllowed: true })[0]!.state).toBe("done");
	});

	it("names the ids a send carries: only the files the server has, in the order they were added", () => {
		let files = [
			file("a", { status: { type: "complete" }, sent: SENT }),
			file("b"),
			file("c", { status: { type: "complete" }, sent: { ...SENT, id: "s3" } }),
		];
		expect(sentIds(files)).toEqual(["s1", "s3"]);
	});

	it("gives the props of a chip and of a sent file, so the elements that draw them take them as they are", () => {
		let [view] = viewFiles([file("a", { size: 1_572_864, status: { type: "complete" } })], {
			imagesAllowed: true,
		});
		expect(chipProps(view!)).toEqual({
			name: "a.png",
			meta: "1.5 MB",
			state: "done",
			progress: 100,
			kind: "image",
		});
		expect(
			messageFileProps({
				id: "x",
				name: "n.md",
				kind: "file",
				mimeType: "text/plain",
				size: 20_480,
			}),
		).toEqual({
			id: "x",
			name: "n.md",
			size: "20 KB",
			kind: "file",
		});
	});
});
