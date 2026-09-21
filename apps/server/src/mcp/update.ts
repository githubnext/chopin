import { createHash } from "node:crypto";

import { canonical, MAX_REQUEST_BYTES } from "./create";

import type { Issue } from "@chopin/dialect";
import type { CreatedDocument } from "../mcp";

export type UpdateDocumentInput = {
	id: string;
	revision: number;
	plan: string;
	idempotencyKey: string;
	fingerprint: string;
};

type UpdateArguments = Omit<UpdateDocumentInput, "fingerprint">;

export type UpdateClient = {
	name: string;
	version: string;
};

const MAX_DOCUMENT_LOCATOR_LENGTH = 2_048;

function nonblank(value: unknown, maximum: number): string | undefined {
	return typeof value === "string"
			&& Array.from(value).length <= maximum
			&& value.trim().length > 0
		? value
		: undefined;
}

function parseUpdateArguments(value: Record<string, unknown>): UpdateArguments | undefined {
	let expected = ["id", "revision", "plan", "idempotencyKey"];
	if (
		Object.keys(value).length !== expected.length
		|| expected.some(key => !Object.hasOwn(value, key))
	) return undefined;
	let id = nonblank(value.id, MAX_DOCUMENT_LOCATOR_LENGTH);
	let idempotencyKey = nonblank(value.idempotencyKey, 128);
	let plan = nonblank(value.plan, MAX_REQUEST_BYTES);
	if (
		!id
		|| !idempotencyKey
		|| !plan
		|| !Number.isSafeInteger(value.revision)
		|| (value.revision as number) < 0
	) return undefined;
	return { id, revision: value.revision as number, plan, idempotencyKey };
}

function fingerprint(input: UpdateArguments): string {
	return createHash("sha256").update(JSON.stringify({
		idempotencyKey: input.idempotencyKey,
		id: input.id,
		revision: input.revision,
		plan: input.plan,
	})).digest("hex");
}

export function prepareUpdate(
	value: Record<string, unknown>,
): { input: UpdateDocumentInput } | { issues: Issue[] } | undefined {
	let input = parseUpdateArguments(value);
	if (!input) return undefined;
	let prepared = canonical(input.plan);
	if ("issues" in prepared) return prepared;
	return {
		input: {
			...input,
			plan: prepared.source,
			fingerprint: fingerprint(input),
		},
	};
}

export type UpdateDocument<Caller> = {
	update(
		caller: Caller,
		input: UpdateDocumentInput,
		client: UpdateClient,
	): Promise<
		| { kind: "updated" | "replayed"; document: CreatedDocument }
		| { kind: "conflict" }
		| { kind: "revision-conflict"; revision: number }
		| { kind: "locked" }
		| { kind: "protected" }
		| { kind: "archived" }
		| { kind: "forbidden" }
		| { kind: "unavailable" }
	>;
};
