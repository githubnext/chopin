import { describe, expect, test } from "bun:test";

import { bigPng, fixture } from "../images/raster.test-fixtures";
import { contractId as id, openedStorage, userAndChannel } from "./contract-support";
import { StorageError } from "./errors";

import type { StorageFactory } from "./contract-support";

/** Distinct bytes per test: a shared database keeps earlier tests' uploads. */
function png(): Uint8Array {
	return new Uint8Array([
		0x89,
		0x50,
		0x4e,
		0x47,
		0x0d,
		0x0a,
		0x1a,
		0x0a,
		...new TextEncoder().encode(crypto.randomUUID()),
	]);
}

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function imageContract(name: string, factory: StorageFactory) {
	describe(`${name} images`, () => {
		test("keeps the first upload of the same bytes per document", async () => {
			let storage = await openedStorage(factory);
			let PNG = png();
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let hash = sha256(PNG);
				let first = new Date("2026-01-02T03:04:05.000Z");
				let input = { channelId, sha256: hash, mimeType: "image/png", uploadedBy: userId };
				await storage.images.put({ ...input, bytes: PNG, now: first });
				await storage.images.put({
					...input,
					bytes: PNG,
					now: new Date("2026-01-03T03:04:05.000Z"),
				});

				let stored = await storage.images.get(channelId, hash);
				expect(stored).toEqual({
					channelId,
					sha256: hash,
					mimeType: "image/png",
					bytes: PNG,
					size: PNG.byteLength,
					uploadedBy: userId,
					createdAt: first,
				});
				stored!.bytes[0] = 0;
				expect((await storage.images.get(channelId, hash))?.bytes[0]).toBe(0x89);
				expect(await storage.images.channels(hash)).toEqual([channelId]);
				expect(await storage.images.get(channelId, "0".repeat(64))).toBeUndefined();
				expect(await storage.images.channels("0".repeat(64))).toEqual([]);
			} finally {
				await storage.close();
			}
		});

		test("keeps an image of any hosted raster type and of any size", async () => {
			let storage = await openedStorage(factory);
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let now = new Date("2026-01-02T03:04:05.000Z");
				let images: Array<[string, Uint8Array]> = [
					["image/avif", fixture("raster-18x6.avif")],
					["image/bmp", fixture("raster-18x6.bmp")],
					["image/x-icon", fixture("raster-18x6.ico")],
					["image/webp", fixture("the-cap.webp")],
					["image/png", bigPng(1_048_577)],
					["image/png", bigPng(1_080_993, 41)],
					["image/png", bigPng(5 * 1024 * 1024, 42)],
				];
				for (let [mimeType, bytes] of images) {
					let hash = sha256(bytes);
					await storage.images.put({
						channelId,
						sha256: hash,
						mimeType,
						bytes,
						uploadedBy: userId,
						now,
					});
					let stored = await storage.images.get(channelId, hash);
					expect(stored?.mimeType, `${mimeType} ${bytes.byteLength}`).toBe(mimeType);
					expect(stored?.size, `${mimeType} ${bytes.byteLength}`).toBe(bytes.byteLength);
					expect(sha256(stored!.bytes), `${mimeType} ${bytes.byteLength}`).toBe(hash);
				}
			} finally {
				await storage.close();
			}
		});

		test("lists every document an image belongs to and forgets a deleted one", async () => {
			let storage = await openedStorage(factory);
			let PNG = png();
			try {
				let { channelId, userId } = await userAndChannel(storage);
				let now = new Date("2026-01-02T03:04:05.000Z");
				let other = await storage.channels.create({
					id: id("image-other-channel"),
					repositoryId: id("image-other-repository"),
					repositoryOwner: "octo-org",
					repositoryName: "other",
					title: "Other plan",
					createdBy: userId,
					now,
				});
				let hash = sha256(PNG);
				let input = { sha256: hash, mimeType: "image/png", bytes: PNG, uploadedBy: userId };
				await storage.images.put({ ...input, channelId, now });
				await storage.images.put({
					...input,
					channelId: other.id,
					now: new Date("2026-01-02T04:04:05.000Z"),
				});
				expect(await storage.images.channels(hash)).toEqual([channelId, other.id]);

				await storage.channels.archive({ id: other.id, now });
				expect(await storage.channels.delete(other.id)).toBe(true);
				expect(await storage.images.channels(hash)).toEqual([channelId]);
				expect(await storage.images.get(other.id, hash)).toBeUndefined();
			} finally {
				await storage.close();
			}
		});

		test("refuses an image for a missing document", async () => {
			let storage = await openedStorage(factory);
			let PNG = png();
			try {
				let { userId } = await userAndChannel(storage);
				let failure = await storage.images.put({
					channelId: id("image-missing-channel"),
					sha256: sha256(PNG),
					mimeType: "image/png",
					bytes: PNG,
					uploadedBy: userId,
					now: new Date("2026-01-02T03:04:05.000Z"),
				}).catch(err => err);
				expect(failure).toBeInstanceOf(StorageError);
				expect((failure as StorageError).failure).toBe("missing");
			} finally {
				await storage.close();
			}
		});
	});
}
