import { createHash } from "node:crypto";

import { limits, lookup, parse, serialize, ulid, validate } from "@chopin/dialect";

import * as room from "../plan/room";

import type { Issue } from "@chopin/dialect";
import type { Nodes, Parent, Root } from "mdast";

export type Brief = {
	goal: string;
	constraints: string[];
	settledDecisions: string[];
	openQuestions: string[];
	repositoryFindings: string[];
};

export type CreationOrigin = {
	idempotencyKey: string;
	fingerprint: string;
	repository: string;
	baseBranch: string;
	baseCommit: string;
	title: string;
};

export type CreateDocumentInput = CreationOrigin & {
	brief: Brief;
	plan: string;
};

type CreateArguments = Omit<CreateDocumentInput, "fingerprint">;

const OWNER_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}";
const REPOSITORY_PATTERN = "(?!\\.\\.?$)[A-Za-z0-9._-]{1,100}";
export const REPOSITORY_PATH_PATTERN = `^${OWNER_PATTERN}/${REPOSITORY_PATTERN}$`;
/** Allows a maximally sized MDX plan plus JSON escaping and its structured brief. */
export const MAX_REQUEST_BYTES = limits.MAX_SOURCE_BYTES * 3;
export const MAX_TITLE_LENGTH = 120;

const OWNER = new RegExp(`^${OWNER_PATTERN}$`);
const REPOSITORY = new RegExp(`^${REPOSITORY_PATTERN}$`);

export const BRIEF = {
	type: "object",
	properties: {
		goal: { type: "string", minLength: 1 },
		constraints: { type: "array", items: { type: "string" } },
		settledDecisions: { type: "array", items: { type: "string" } },
		openQuestions: { type: "array", items: { type: "string" } },
		repositoryFindings: { type: "array", items: { type: "string" } },
	},
	required: ["goal", "constraints", "settledDecisions", "openQuestions", "repositoryFindings"],
	additionalProperties: false,
};

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every(item => typeof item === "string") ? value : undefined;
}

function nonblank(value: unknown, maximum: number): string | undefined {
	return typeof value === "string"
			&& Array.from(value).length <= maximum
			&& value.trim().length > 0
		? value
		: undefined;
}

export function isRepository(value: unknown): value is string {
	if (typeof value !== "string") return false;
	let parts = value.split("/");
	return parts.length === 2 && OWNER.test(parts[0]!) && REPOSITORY.test(parts[1]!);
}

function arguments_(value: Record<string, unknown>): CreateArguments | undefined {
	let expected = [
		"idempotencyKey",
		"repository",
		"baseBranch",
		"baseCommit",
		"title",
		"brief",
		"plan",
	];
	if (
		Object.keys(value).length !== expected.length
		|| expected.some(key => !Object.hasOwn(value, key))
	) return undefined;
	let brief = record(value.brief);
	let goal = nonblank(brief?.goal, 4_096);
	let constraints = strings(brief?.constraints);
	let settledDecisions = strings(brief?.settledDecisions);
	let openQuestions = strings(brief?.openQuestions);
	let repositoryFindings = strings(brief?.repositoryFindings);
	let idempotencyKey = nonblank(value.idempotencyKey, 128);
	let baseBranch = nonblank(value.baseBranch, 255);
	let baseCommit = nonblank(value.baseCommit, 64);
	let title = nonblank(value.title, MAX_TITLE_LENGTH);
	let plan = nonblank(value.plan, MAX_REQUEST_BYTES);
	if (
		!idempotencyKey
		|| !isRepository(value.repository)
		|| !baseBranch
		|| !baseCommit
		|| !title
		|| !goal
		|| !constraints
		|| !settledDecisions
		|| !openQuestions
		|| !repositoryFindings
		|| !plan
	) return undefined;
	return {
		idempotencyKey,
		repository: value.repository,
		baseBranch,
		baseCommit,
		title,
		brief: { goal, constraints, settledDecisions, openQuestions, repositoryFindings },
		plan,
	};
}

function identify(node: Nodes | Root): void {
	if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
		let component = lookup(node.name);
		if (
			component?.attributes.id?.required
			&& !node.attributes.some(attribute =>
				attribute.type === "mdxJsxAttribute" && attribute.name === "id"
			)
		) node.attributes.unshift({ type: "mdxJsxAttribute", name: "id", value: ulid() });
	}
	if ("children" in node) {
		for (let child of (node as Parent).children) identify(child);
	}
}

function canonical(source: string): { source: string } | { issues: Issue[] } {
	let tree: Root;
	try {
		tree = parse(source);
	} catch (err) {
		return {
			issues: [{
				code: "parse",
				message: err instanceof Error ? err.message : String(err),
				path: "root",
			}],
		};
	}
	identify(tree);
	let output = serialize(tree);
	let result = validate(tree, { bytes: Buffer.byteLength(output, "utf8") });
	if (!result.ok) return { issues: result.issues };
	room.validate(output);
	return { source: output };
}

function fingerprint(input: CreateArguments): string {
	return createHash("sha256").update(JSON.stringify({
		idempotencyKey: input.idempotencyKey,
		repository: input.repository,
		baseBranch: input.baseBranch,
		baseCommit: input.baseCommit,
		title: input.title,
		brief: {
			goal: input.brief.goal,
			constraints: input.brief.constraints,
			settledDecisions: input.brief.settledDecisions,
			openQuestions: input.brief.openQuestions,
			repositoryFindings: input.brief.repositoryFindings,
		},
		plan: input.plan,
	})).digest("hex");
}

/** Turn untrusted tool arguments into the only input a host adapter can receive. */
export function prepare(
	value: Record<string, unknown>,
): { input: CreateDocumentInput } | { issues: Issue[] } | undefined {
	let input = arguments_(value);
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
