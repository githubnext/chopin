import { missing } from "../errors";

import type { PutImage, StoredImage } from "../model";
import type { ImageStore } from "../port";

function copy(value: StoredImage): StoredImage {
	return { ...value, bytes: new Uint8Array(value.bytes), createdAt: new Date(value.createdAt) };
}

export class MemoryImageStore implements ImageStore {
	#images = new Map<string, StoredImage>();
	constructor(
		private options: {
			channelExists: (id: string) => boolean;
			userExists: (id: string) => boolean;
		},
	) {}
	async put(input: PutImage) {
		if (!this.options.channelExists(input.channelId)) {
			throw missing(`channel ${input.channelId} does not exist`);
		}
		if (!this.options.userExists(input.uploadedBy)) {
			throw missing(`user ${input.uploadedBy} does not exist`);
		}
		let key = `${input.channelId}:${input.sha256}`;
		if (this.#images.has(key)) return;
		let { now, ...image } = input;
		this.#images.set(key, copy({ ...image, size: input.bytes.byteLength, createdAt: now }));
	}
	async get(channelId: string, sha256: string) {
		let found = this.#images.get(`${channelId}:${sha256}`);
		return found && copy(found);
	}
	async channels(sha256: string) {
		return [...this.#images.values()].filter(image => image.sha256 === sha256)
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
			.map(image => image.channelId);
	}
	deleteChannel(channelId: string) {
		for (let [key, image] of this.#images) {
			if (image.channelId === channelId) this.#images.delete(key);
		}
	}
}
