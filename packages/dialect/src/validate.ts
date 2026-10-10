/**
 * Dialect validation.
 *
 * Runs on the server before any update is accepted, and on clients for immediate
 * feedback. Returns every issue rather than failing on the first, so the agent
 * and the editor can report actionable diagnostics.
 *
 * Issues carry structure (names, counts, limits, offsets) and never echo user
 * or agent prose, so they stay safe to log.
 */

import * as dialect from "./dialect";
import * as limits from "./limits";
import { ULID } from "./ulid";

import type { Nodes, Parent, Root } from "mdast";
import type { MdxJsxAttribute, MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx-jsx";

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type Issue = {
	/** Machine-readable, stable across releases. */
	code: string;
	message: string;
	/** Structural location, e.g. `root > Tabs > Tab[1]`. */
	path: string;
	/** Byte offset in source when the node carries position info. */
	offset?: number;
};

export type Result = { ok: true } | { ok: false; issues: Issue[] };

export type Options = {
	/** Total source size, checked when supplied. */
	bytes?: number;
};

type Jsx = MdxJsxFlowElement | MdxJsxTextElement;

function isJsx(node: Nodes): node is Jsx {
	return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
}

function stringAttribute(node: Jsx, name: string): string | undefined {
	let found = node.attributes.find(attribute =>
		attribute.type === "mdxJsxAttribute" && attribute.name === name
	);
	return found?.type === "mdxJsxAttribute" && typeof found.value === "string"
		? found.value
		: undefined;
}

function children(node: Nodes): Nodes[] {
	return (node as Parent).children ?? [];
}

function label(node: Nodes): string {
	return isJsx(node) ? node.name ?? "fragment" : node.type;
}

class Validator {
	readonly #issues: Issue[] = [];
	#images = 0;

	get issues(): Issue[] {
		return this.#issues;
	}

	add(code: string, message: string, path: string, node?: Nodes): void {
		this.#issues.push({
			code,
			message,
			path,
			...(node?.position ? { offset: node.position.start.offset } : {}),
		});
	}

	run(root: Root, options: Options): void {
		if (options.bytes !== undefined && options.bytes > limits.MAX_SOURCE_BYTES) {
			this.add(
				"source-too-large",
				`Plan exceeds the ${limits.MAX_SOURCE_BYTES / 1024} KiB limit`,
				"root",
			);
		}

		this.#walk(root, "root", 0, []);

		if (this.#images > limits.MAX_IMAGES) {
			this.add("too-many-images", `Plan exceeds ${limits.MAX_IMAGES} images`, "root");
		}
	}

	#walk(node: Nodes, path: string, depth: number, ancestors: string[], parent?: Jsx): void {
		if (depth > limits.MAX_DEPTH) {
			this.add("too-deep", `Content nests deeper than ${limits.MAX_DEPTH} levels`, path, node);
			return;
		}

		if (dialect.FORBIDDEN_NODES.includes(node.type)) {
			this.add("forbidden-node", `\`${node.type}\` is not allowed in plans`, path, node);
			return;
		}

		if (!dialect.NODES.includes(node.type)) {
			this.add("unknown-node", `\`${node.type}\` is not part of the plan dialect`, path, node);
			return;
		}

		if (isJsx(node)) {
			this.#component(node, path, depth, ancestors, parent);
			return;
		}

		switch (node.type) {
			case "link":
				this.#link(node.url, path, node);
				break;
			case "image":
				this.#image(node.url, path, node);
				break;
			case "table":
				this.#table(node, path, node);
				break;
			case "footnoteDefinition":
			case "footnoteReference":
				// mdast normalises `identifier` to lower case; ULIDs are upper case.
				if (!ULID.test(node.identifier.toUpperCase())) {
					this.add("bad-footnote-id", "Footnote identifiers must be ULIDs", path, node);
				}
				break;
		}

		this.#descend(node, path, depth, ancestors);
	}

	#descend(node: Nodes, path: string, depth: number, ancestors: string[]): void {
		let counts = new Map<string, number>();
		for (let child of children(node)) {
			let name = label(child);
			let index = counts.get(name) ?? 0;
			counts.set(name, index + 1);
			this.#walk(
				child,
				`${path} > ${name}[${index}]`,
				depth + 1,
				ancestors,
				isJsx(node) ? node : undefined,
			);
		}
	}

	#component(node: Jsx, path: string, depth: number, ancestors: string[], parentNode?: Jsx): void {
		if (!node.name) {
			this.add("fragment", "JSX fragments are not allowed in plans", path, node);
			return;
		}

		let spec = dialect.lookup(node.name);
		if (!spec) {
			this.add("unknown-component", `\`${node.name}\` is not a plan component`, path, node);
			return;
		}
		if (spec.name === "Columns" && depth !== 1) {
			this.add("bad-layout-placement", "`Columns` must be a top-level block", path, node);
		}

		let expected = node.type === "mdxJsxFlowElement" ? "flow" : "text";
		if (spec.kind !== "both" && spec.kind !== expected) {
			this.add(
				"wrong-kind",
				`\`${spec.name}\` is a ${spec.kind} component but was used as ${expected}`,
				path,
				node,
			);
		}

		let parent = ancestors.at(-1);
		if (spec.parent && (!parent || !spec.parent.includes(parent))) {
			this.add(
				"bad-parent",
				`\`${spec.name}\` must be a direct child of ${spec.parent.join(" or ")}`,
				path,
				node,
			);
		}

		for (let ancestor of ancestors) {
			let outer = dialect.lookup(ancestor);
			if (outer?.forbids?.includes(spec.name)) {
				this.add(
					"bad-nesting",
					`\`${spec.name}\` cannot appear inside \`${ancestor}\``,
					path,
					node,
				);
				break;
			}
		}

		this.#attributes(node, spec, path);
		this.#content(node, spec, path, parentNode);
		if (spec.name === "Question") this.#questionChoices(node, path);
		if (spec.name === "Image") this.#image(stringAttribute(node, "src") ?? "", path, node);

		this.#descend(node, path, depth, [...ancestors, spec.name]);
	}

	#questionChoices(node: Jsx, path: string): void {
		let elements = children(node).filter(isJsx);
		let options = new Set(
			elements.filter(item => item.name === "Option")
				.map(item => stringAttribute(item, "id")),
		);
		for (let answer of elements.filter(item => item.name === "Answer")) {
			let raw = stringAttribute(answer, "choices");
			if (raw === undefined) continue;
			let chosen = raw.trim().split(/\s+/).filter(Boolean);
			if (chosen.length > limits.MAX_OPTIONS) {
				this.add(
					"too-many-answer-choices",
					`Answer accepts at most ${limits.MAX_OPTIONS} choices`,
					path,
					answer,
				);
			}
			if (chosen.some(id => !options.has(id))) {
				this.add(
					"unknown-answer-choice",
					"Answer choices must name options in this question",
					path,
					answer,
				);
			}
			if (new Set(chosen).size !== chosen.length) {
				this.add("duplicate-answer-choice", "Answer choices cannot repeat an option", path, answer);
			}
			if (stringAttribute(node, "multiple") === "false" && chosen.length > 1) {
				this.add("too-many-answer-choices", "This question accepts one choice", path, answer);
			}
		}

		let previous = elements.filter(item => item.name === "Previous");
		if (previous.length > 1) {
			this.add("duplicate-previous", "Question accepts at most one Previous", path, node);
		}
		for (let item of previous) {
			let raw = stringAttribute(item, "choices");
			let value = stringAttribute(item, "value");
			if ((raw === undefined) === (value === undefined)) {
				this.add(
					"invalid-previous-answer",
					"Previous requires choices or value, but not both",
					path,
					item,
				);
			}
			if (raw === undefined) continue;
			let chosen = raw.trim().split(/\s+/).filter(Boolean);
			if (chosen.length > limits.MAX_OPTIONS) {
				this.add(
					"too-many-previous-choices",
					`Previous accepts at most ${limits.MAX_OPTIONS} choices`,
					path,
					item,
				);
			}
			if (chosen.some(id => !options.has(id))) {
				this.add(
					"unknown-previous-choice",
					"Previous choices must name options in this question",
					path,
					item,
				);
			}
			if (new Set(chosen).size !== chosen.length) {
				this.add(
					"duplicate-previous-choice",
					"Previous choices cannot repeat an option",
					path,
					item,
				);
			}
			if (stringAttribute(node, "multiple") === "false" && chosen.length > 1) {
				this.add("too-many-previous-choices", "This question accepts one choice", path, item);
			}
		}
	}

	#attributes(node: Jsx, spec: dialect.Component, path: string): void {
		let seen = new Map<string, string>();

		for (let attribute of node.attributes) {
			if (attribute.type !== "mdxJsxAttribute") {
				this.add("spread-attribute", "Spread attributes are not allowed", path, node);
				continue;
			}

			let { name, value } = attribute as MdxJsxAttribute;

			if (typeof value !== "string") {
				this.add(
					"expression-attribute",
					`\`${name}\` must be a quoted string, not an expression`,
					path,
					node,
				);
				continue;
			}

			if (!Object.hasOwn(spec.attributes, name)) {
				this.add("unknown-attribute", `\`${spec.name}\` has no \`${name}\` attribute`, path, node);
				continue;
			}

			if (seen.has(name)) {
				this.add("duplicate-attribute", `\`${name}\` is set more than once`, path, node);
				continue;
			}

			seen.set(name, value);
		}

		for (let [name, attribute] of Object.entries(spec.attributes)) {
			let value = seen.get(name);

			if (value === undefined) {
				if (attribute.required) {
					this.add("missing-attribute", `\`${spec.name}\` requires \`${name}\``, path, node);
				}
				continue;
			}

			switch (attribute.type) {
				case "id":
					if (!ULID.test(value)) {
						this.add("bad-id", `\`${spec.name}.${name}\` must be a ULID`, path, node);
					}
					break;

				case "reference":
					if (value.length > attribute.max || !REFERENCE.test(value)) {
						this.add(
							"bad-reference",
							`\`${spec.name}.${name}\` must be a safe external reference`,
							path,
							node,
						);
					}
					break;

				case "text":
					if (
						!value.trim() && !attribute.empty
						&& !["Question", "Option", "Answer"].includes(spec.name)
					) {
						this.add("empty-attribute", `\`${spec.name}.${name}\` cannot be empty`, path, node);
					} else if (value.length > attribute.max) {
						this.add(
							"attribute-too-long",
							`\`${spec.name}.${name}\` exceeds ${attribute.max} characters`,
							path,
							node,
						);
					}
					break;
				case "integer":
					if (
						!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) < attribute.min
						|| Number(value) > attribute.max
					) {
						this.add(
							"bad-attribute-value",
							`\`${spec.name}.${name}\` must be an integer from ${attribute.min} to ${attribute.max}`,
							path,
							node,
						);
					}
					break;
				case "enum":
					if (!attribute.values.includes(value)) {
						this.add(
							"bad-attribute-value",
							`\`${spec.name}.${name}\` must be one of ${attribute.values.join(", ")}`,
							path,
							node,
						);
					}
					break;
			}
		}
	}

	#content(node: Jsx, spec: dialect.Component, path: string, parent?: Jsx): void {
		let kids = children(node);

		switch (spec.content.type) {
			case "empty":
				if (kids.length > 0) {
					this.add("unexpected-children", `\`${spec.name}\` cannot have children`, path, node);
				}
				break;

			case "components": {
				let allowed = spec.content.names;
				let found = 0;
				for (let child of kids) {
					// Whitespace between block components is an artefact of formatting.
					if (child.type === "text" && !child.value.trim()) continue;
					let name = isJsx(child) ? child.name : undefined;
					if (!name || !allowed.includes(name)) {
						this.add(
							"unexpected-child",
							`\`${spec.name}\` may only contain ${allowed.join(", ")}`,
							path,
							child,
						);
						continue;
					}
					found++;
				}
				if (spec.name === "Columns" && found !== 2) {
					this.add("bad-column-count", "`Columns` requires exactly two columns", path, node);
				}
				let pendingQuestion = spec.name === "Question" && parent?.name === "Questionnaire"
					&& !!stringAttribute(parent, "thread")
					&& children(parent).filter(child => isJsx(child) && child.name === "Question").length
						=== 1
					&& ["open", "reopened", "discarded"].includes(
						stringAttribute(parent, "status") ?? "",
					)
					&& stringAttribute(node, "multiple") === "false";
				// A free-text question, from a card with no thread that is open or expired,
				// has no options until its answer is projected.
				let freeTextQuestion = spec.name === "Question" && parent?.name === "Questionnaire"
					&& !stringAttribute(parent, "thread")
					&& [undefined, "expired"].includes(stringAttribute(parent, "status"));
				if (found === 0 && !pendingQuestion && !freeTextQuestion) {
					this.add(
						"missing-children",
						`\`${spec.name}\` requires at least one ${allowed.join(" or ")}`,
						path,
						node,
					);
				}
				break;
			}

			case "blocks":
			case "phrasing":
				break;
		}
	}

	#link(url: string, path: string, node: Nodes): void {
		// Relative repository paths and Ace references carry no protocol.
		if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return;

		let protocol: string;
		try {
			protocol = new URL(url).protocol;
		} catch {
			this.add("bad-link", "Link is not a valid URL", path, node);
			return;
		}

		if (!dialect.LINK_PROTOCOLS.includes(protocol)) {
			this.add("bad-link-protocol", `\`${protocol}\` links are not allowed`, path, node);
		}
	}

	#image(url: string, path: string, node: Nodes): void {
		this.#images++;
		// Chopin's own uploads are the one relative form: the server that renders
		// the document also serves them, so they resolve against its origin.
		if (dialect.HOSTED_IMAGE_PATH.test(url)) return;

		let protocol: string;
		try {
			protocol = new URL(url).protocol;
		} catch {
			// Any other relative image has nothing to resolve against.
			this.add(
				"bad-image",
				"Image must be an absolute URL or a Chopin-hosted /images/ path",
				path,
				node,
			);
			return;
		}

		if (!dialect.IMAGE_PROTOCOLS.includes(protocol)) {
			this.add("bad-image-protocol", `\`${protocol}\` images are not allowed`, path, node);
		}
	}

	#table(node: Extract<Nodes, { type: "table" }>, path: string, origin: Nodes): void {
		let rows = node.children.length;
		if (rows > limits.MAX_TABLE_ROWS) {
			this.add(
				"table-too-tall",
				`Tables are limited to ${limits.MAX_TABLE_ROWS} rows`,
				path,
				origin,
			);
		}

		let columns = 0;
		for (let row of node.children) columns = Math.max(columns, row.children.length);
		if (columns > limits.MAX_TABLE_COLUMNS) {
			this.add(
				"table-too-wide",
				`Tables are limited to ${limits.MAX_TABLE_COLUMNS} columns`,
				path,
				origin,
			);
		}
	}
}

/** Validate a parsed plan against the dialect. */
export function validate(root: Root, options: Options = {}): Result {
	let validator = new Validator();
	validator.run(root, options);
	return validator.issues.length === 0 ? { ok: true } : { ok: false, issues: validator.issues };
}

/** Thrown by {@link assert} when a plan violates the dialect. */
export class PlanValidationError extends Error {
	override readonly name = "PlanValidationError";
	readonly issues: Issue[];

	constructor(issues: Issue[]) {
		let summary = issues
			.slice(0, 3)
			.map(issue => `${issue.path}: ${issue.message}`)
			.join("; ");
		let more = issues.length > 3 ? ` (+${issues.length - 3} more)` : "";
		super(`Invalid plan MDX — ${summary}${more}`);
		this.issues = issues;
	}
}

/**
 * Validate, throwing on failure.
 *
 * @throws {PlanValidationError}
 */
export function assert(root: Root, options: Options = {}): void {
	let result = validate(root, options);
	if (!result.ok) throw new PlanValidationError(result.issues);
}

/** The URL destination shared by Markdown images and their sized JSX representation. */
function destination(node: Nodes): { url: string; kind: "link" | "image" } | undefined {
	if (node.type === "link" || node.type === "image") return { url: node.url, kind: node.type };
	if (isJsx(node) && node.name === "Image") {
		let url = stringAttribute(node, "src");
		if (url !== undefined) return { url, kind: "image" };
	}
	return undefined;
}

/** Every link and image URL under these nodes. */
function urls(nodes: readonly Nodes[], found = new Set<string>()): Set<string> {
	for (let node of nodes) {
		let target = destination(node);
		if (target) found.add(target.url);
		urls(children(node), found);
	}
	return found;
}

/**
 * Refuse unsafe link and image URLs that a change brings in.
 *
 * Hidden characters (which browsers strip or hide, so `\u0001javascript:`
 * resolves to a scheme no pattern saw) and scheme-less links that name
 * another host (`//host`, anything with `\`) were refused only after
 * documents were already stored with them. Whole-document validation runs
 * whenever a room opens, restores, rebuilds or checks a batch, so refusing
 * them there would lock people out of their own documents. These rules judge
 * what a change introduces instead: a URL already present in `before` is left
 * alone, wherever it ends up.
 *
 * @throws {PlanValidationError}
 */
export function assertIntroducedUrls(before: readonly Nodes[], after: readonly Nodes[]): void {
	let known = urls(before);
	let issues: Issue[] = [];
	let visit = (nodes: readonly Nodes[], path: string) => {
		let counts = new Map<string, number>();
		for (let node of nodes) {
			let name = label(node);
			let index = counts.get(name) ?? 0;
			counts.set(name, index + 1);
			let here = `${path} > ${name}[${index}]`;
			let target = destination(node);
			if (target && !known.has(target.url)) {
				let problem = dialect.disguisedUrl(target.url, target.kind);
				if (problem) {
					issues.push({
						code: target.kind === "image" ? "bad-image" : "bad-link",
						message: problem,
						path: here,
						...(node.position ? { offset: node.position.start.offset } : {}),
					});
				}
			}
			visit(children(node), here);
		}
	};
	visit(after, "root");
	if (issues.length > 0) throw new PlanValidationError(issues);
}
