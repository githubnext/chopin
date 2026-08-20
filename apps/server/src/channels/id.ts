import { createHash } from "node:crypto";

/** New channels are UUIDv5-shaped; UUIDv4 remains valid for existing channels. */
const CHANNEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isChannelId(value: string): boolean {
	return CHANNEL.test(value);
}

/** Stable identity for one repository-scoped name. */
export function deterministicChannelId(repositoryId: string, name: string): string {
	let bytes = createHash("sha256")
		.update(repositoryId)
		.update("\0")
		.update(name)
		.digest();
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	let hex = bytes.toString("hex", 0, 16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
		hex.slice(20)
	}`;
}

/** Mint a fresh canonical channel id in the same namespace as deterministic creation. */
export function newChannelId(repositoryId: string): string {
	return deterministicChannelId(repositoryId, crypto.randomUUID());
}
