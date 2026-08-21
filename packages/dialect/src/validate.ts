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

function children(node: Nodes): Nodes[] {
	return (node as Parent).children ?? [];
}

function label(node: Nodes): string {
	return isJsx(node) ? node.name ?? "fragment" : node.type;
}

class Validator {
	readonly #issues: Issue[] = [];
	readonly #researchIds = new Set<string>();
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

	#walk(node: Nodes, path: string, depth: number, ancestors: string[]): void {
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
			this.#component(node, path, depth, ancestors);
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
			this.#walk(child, `${path} > ${name}[${index}]`, depth + 1, ancestors);
		}
	}

	#component(node: Jsx, path: string, depth: number, ancestors: string[]): void {
		if (!node.name) {
			this.add("fragment", "JSX fragments are not allowed in plans", path, node);
			return;
		}

		let spec = dialect.lookup(node.name);
		if (!spec) {
			this.add("unknown-component", `\`${node.name}\` is not a plan component`, path, node);
			return;
		}

		let expected = node.type === "mdxJsxFlowElement" ? "flow" : "text";
		if (spec.kind !== expected) {
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
		this.#content(node, spec, path);

		this.#descend(node, path, depth, [...ancestors, spec.name]);
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
					} else if (spec.name === "ResearchQuestion") {
						if (this.#researchIds.has(value)) {
							this.add("duplicate-id", "Research question ids must be unique", path, node);
						}
						this.#researchIds.add(value);
					}
					break;

				case "text":
					if (!value.trim()) {
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

	#content(node: Jsx, spec: dialect.Component, path: string): void {
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
				if (found === 0) {
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

		let protocol: string;
		try {
			protocol = new URL(url).protocol;
		} catch {
			// Unlike a link, an image has no relative form worth accepting: there
			// is nothing to resolve it against.
			this.add("bad-image", "Image must be an absolute URL", path, node);
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
