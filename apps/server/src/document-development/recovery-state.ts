import * as Y from "yjs";
import { createHash } from "node:crypto";
import { limits } from "@chopin/dialect";
import type { Plan as Wire } from "@chopin/protocol";

export const MAX_RETIRED = 48;
export const MAX_RECOVERY_ADMISSION_BYTES = 1024 * 1024;
export type RecoveryVersion = {
	digest: string;
	source: string;
	status: "pending" | "added" | "dismissed";
};
export type RetiredPassage = {
	id: string;
	passageId: string;
	anchor: Wire.Anchor;
	seenDigest: string;
	version?: RecoveryVersion;
};
export type Recovery = {
	epoch: string;
	document: string;
	/** Automatic deletions omitted from the recovery document, encoded as a Yjs snapshot. */
	deletes: string;
	retired: RetiredPassage[];
};

function invalid(): never {
	throw new Error("hosted channel has invalid document development recovery");
}
function object(value: unknown, required: string[], optional: string[] = []) {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	let item = value as Record<string, unknown>;
	if (
		required.some(key => !Object.hasOwn(item, key))
		|| Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))
	) invalid();
	return item;
}
function id(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 200 || /\s/.test(value)) invalid();
	return value;
}
function digest(value: unknown): string {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid();
	return value;
}
function bytes(value: unknown): string {
	if (typeof value !== "string" || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid();
	if (Buffer.from(value, "base64").toString("base64") !== value) invalid();
	return value;
}

export function restoreRecovery(
	value: unknown,
	anchor: (value: unknown) => Wire.Anchor,
): Recovery {
	let item = object(value, ["epoch", "document", "deletes", "retired"]);
	if (!Array.isArray(item.retired) || item.retired.length > MAX_RETIRED) invalid();
	let document = bytes(item.document);
	let deletes = bytes(item.deletes);
	try {
		Y.decodeUpdate(Buffer.from(document, "base64"));
		let snapshot = Y.decodeSnapshot(Buffer.from(deletes, "base64"));
		if (snapshot.sv.size !== 0) invalid();
	} catch {
		invalid();
	}
	let seen = new Set<string>();
	let retired = item.retired.map(raw => {
		let passage = object(raw, ["id", "passageId", "anchor", "seenDigest"], ["version"]);
		let identity = id(passage.id);
		if (seen.has(identity)) invalid();
		seen.add(identity);
		let version: RecoveryVersion | undefined;
		if (passage.version !== undefined) {
			let value = object(passage.version, ["digest", "source", "status"]);
			if (
				typeof value.source !== "string" || !value.source
				|| Buffer.byteLength(value.source) > limits.MAX_SOURCE_BYTES
				|| !["pending", "added", "dismissed"].includes(value.status as string)
			) invalid();
			if (value.digest !== `sha256:${createHash("sha256").update(value.source).digest("hex")}`) {
				invalid();
			}
			version = {
				digest: digest(value.digest),
				source: value.source,
				status: value.status as RecoveryVersion["status"],
			};
		}
		return {
			id: identity,
			passageId: id(passage.passageId),
			anchor: anchor(passage.anchor),
			seenDigest: digest(passage.seenDigest),
			...(version ? { version } : {}),
		};
	});
	return { epoch: id(item.epoch), document, deletes, retired };
}

export function recoveryBytes(recovery?: Recovery): number {
	return recovery ? Buffer.byteLength(recovery.document, "base64") : 0;
}
