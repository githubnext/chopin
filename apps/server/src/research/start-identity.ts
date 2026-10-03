import { createHash } from "node:crypto";
import type { JsonValue } from "../storage/model";

export type ValidatedStartResearchRequest = {
	channelId: string;
	question: string;
	scope: string;
	origin: "inline" | "planner" | "planner-inline";
	originMessageId?: string;
	requestedBy: string;
	requestedByHandle?: string;
	beforeStart?: () => void | Promise<void>;
	placeReference?: (workspaceId: string) => Promise<"placed" | "deferred">;
};

export function startIdentity(input: ValidatedStartResearchRequest): {
	idempotencyKey: string;
	fingerprint: string;
} {
	let durableOrigin = input.origin === "planner-inline" ? "planner" : input.origin;
	return {
		idempotencyKey: `research-${durableOrigin}:${digest(input.scope).slice(0, 48)}`,
		fingerprint: fingerprint(
			`research-${durableOrigin}`,
			input.origin === "inline"
				? {
					channelId: input.channelId,
					question: input.question,
					requestedBy: input.requestedBy,
					requestedByHandle: input.requestedByHandle ?? null,
				}
				: {
					channelId: input.channelId,
					question: input.question,
					originMessageId: input.originMessageId!,
					requestedBy: input.requestedBy,
					requestedByHandle: input.requestedByHandle ?? null,
				},
		),
	};
}

export function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function fingerprint(kind: string, value: JsonValue): string {
	return digest(`${kind}\0${JSON.stringify(value)}`);
}
