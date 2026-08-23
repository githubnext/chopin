import type { Incoming } from "@chopin/protocol";

export const MAX_SOCKET_FRAME_BYTES = 2 * 1024 * 1024;
export const CHAT_CAPABILITIES = { chatReferences: true, chatSendAcks: true } as const;

const KIND = /^[a-z][a-z0-9:-]{0,63}$/;
const RID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Parse only the bounded request envelope; domain handlers validate their own payloads. */
export function incomingFrame(raw: string): Incoming | undefined {
	if (Buffer.byteLength(raw) > MAX_SOCKET_FRAME_BYTES) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let frame = value as Record<string, unknown>;
	if (typeof frame.kind !== "string" || !KIND.test(frame.kind)) return undefined;
	if (typeof frame.rid !== "string" || !RID.test(frame.rid)) return undefined;
	return frame as Incoming;
}
