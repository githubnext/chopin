import { corrupt, missing } from "../errors";

import type { PutChatAttachment, StagedChatAttachments, StoredChatAttachment } from "../model";
import type { ChatAttachmentStore } from "../port";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** What the table's check holds to: an image is a supported raster, a file is plain text. */
function typed(value: { kind: string; mimeType: string }): boolean {
	return value.kind === "image"
		? IMAGE_TYPES.has(value.mimeType)
		: value.kind === "file" && value.mimeType === "text/plain";
}

function copy(value: StoredChatAttachment): StoredChatAttachment {
	return { ...value, bytes: new Uint8Array(value.bytes), createdAt: new Date(value.createdAt) };
}

export class MemoryChatAttachmentStore implements ChatAttachmentStore {
	#attachments = new Map<string, StoredChatAttachment>();
	constructor(
		private options: {
			channelExists: (id: string) => boolean;
			userExists: (id: string) => boolean;
		},
	) {}
	async put(input: PutChatAttachment) {
		if (!this.options.channelExists(input.channelId)) {
			throw missing(`channel ${input.channelId} does not exist`);
		}
		if (!this.options.userExists(input.uploadedBy)) {
			throw missing(`user ${input.uploadedBy} does not exist`);
		}
		if (!typed(input)) throw corrupt(`a ${input.kind} cannot be stored as ${input.mimeType}`);
		if (input.bytes.byteLength === 0) throw corrupt("an attachment has no bytes");
		if (this.#attachments.has(input.id)) return;
		let { now, ...attachment } = input;
		this.#attachments.set(
			input.id,
			copy({ ...attachment, size: input.bytes.byteLength, createdAt: now }),
		);
	}
	async get(channelId: string, id: string) {
		let found = this.#attachments.get(id);
		return found && found.channelId === channelId ? copy(found) : undefined;
	}
	async staged(channelId: string, userId: string): Promise<StagedChatAttachments> {
		let staged = [...this.#attachments.values()].filter(value =>
			value.channelId === channelId && value.uploadedBy === userId && value.entryId === undefined
		);
		return { count: staged.length, bytes: staged.reduce((sum, value) => sum + value.size, 0) };
	}
	async bind(input: { channelId: string; userId: string; ids: string[]; entryId: string }) {
		let found = input.ids.map(id => this.#attachments.get(id));
		let bindable = found.every(value =>
			value !== undefined && value.channelId === input.channelId
			&& value.uploadedBy === input.userId
			&& (value.entryId === undefined || value.entryId === input.entryId)
		) && new Set(input.ids).size === input.ids.length;
		if (!bindable) return false;
		found.forEach((value, position) => {
			value!.entryId = input.entryId;
			value!.position = position;
		});
		return true;
	}
	async forEntry(channelId: string, entryId: string) {
		return [...this.#attachments.values()]
			.filter(value => value.channelId === channelId && value.entryId === entryId)
			.sort((a, b) => a.position! - b.position!)
			.map(copy);
	}
	async discard(channelId: string, id: string, userId: string) {
		let found = this.#attachments.get(id);
		if (
			!found || found.channelId !== channelId || found.uploadedBy !== userId
			|| found.entryId !== undefined
		) return false;
		return this.#attachments.delete(id);
	}
	async discardEntry(channelId: string, entryId: string) {
		let removed = 0;
		for (let [id, value] of this.#attachments) {
			if (value.channelId === channelId && value.entryId === entryId) {
				this.#attachments.delete(id);
				removed++;
			}
		}
		return removed;
	}
	async prune(before: Date) {
		let removed = 0;
		for (let [id, value] of this.#attachments) {
			if (value.entryId === undefined && value.createdAt < before) {
				this.#attachments.delete(id);
				removed++;
			}
		}
		return removed;
	}
	deleteChannel(channelId: string) {
		for (let [id, value] of this.#attachments) {
			if (value.channelId === channelId) this.#attachments.delete(id);
		}
	}
}
