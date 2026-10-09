import {
	CONTROL_CHARACTER,
	isWireframeKind,
	MAX_WIREFRAME_DEPTH,
	MAX_WIREFRAME_ID,
	MAX_WIREFRAME_LABEL,
	MAX_WIREFRAME_NODES,
	MAX_WIREFRAME_PROBLEMS,
	MAX_WIREFRAME_SOURCE_BYTES,
	type Wireframe,
	WIREFRAME_KINDS,
	type WireframeKindSpec,
	type WireframeNode,
	type WireframeProblem,
	type WireframeResult,
} from "./schema";

type Frame =
	| { width: number; node: WireframeNode }
	| { width: number; item: true }
	| { width: number; rejected: true };

/**
 * Read one wireframe fence line by line.
 *
 * Every line is scanned once, left to right, and the source is bounded before
 * it is split, so hostile input costs at most linear work. User input never
 * throws: each line reports at most one problem, and lines below a rejected
 * line are still checked but never attached, so one mistake does not cascade.
 */
export function parseWireframe(source: string): WireframeResult {
	if (
		source.length > MAX_WIREFRAME_SOURCE_BYTES
		|| new TextEncoder().encode(source).byteLength > MAX_WIREFRAME_SOURCE_BYTES
	) {
		return {
			ok: false,
			problems: [{ line: 1, message: "The wireframe is too large (64 KiB maximum)." }],
		};
	}

	let nodes: WireframeNode[] = [];
	let problems: WireframeProblem[] = [];
	let stack: Frame[] = [];
	let parts = 0;
	let ids = new Map<string, number>();
	let lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);

	for (let index = 0; index < lines.length; index++) {
		if (problems.length >= MAX_WIREFRAME_PROBLEMS) break;
		let number = index + 1;
		let line = lines[index]!;
		let length = line.length;
		while (length && (line[length - 1] === " " || line[length - 1] === "\t")) length--;
		line = line.slice(0, length);
		if (!line) continue;
		let indent = /^[ \t]*/.exec(line)![0];
		let width = indent.length;
		while (stack.length && stack.at(-1)!.width >= width) stack.pop();
		let parent = stack.at(-1);
		let reject = (message: string) => {
			problems.push({ line: number, message });
			stack.push({ width, rejected: true });
		};

		if (indent.includes("\t")) {
			reject("Indent with two spaces, not tabs.");
			continue;
		}
		if (width % 2) {
			reject("Indentation must be a multiple of two spaces.");
			continue;
		}
		let within = parent && "rejected" in parent;
		if (!within && width > (parent ? parent.width + 2 : 0)) {
			reject("This line is indented more than one level below its parent.");
			continue;
		}

		let rest = line.slice(width);
		let owner = parent && "node" in parent ? parent.node : undefined;
		let ownerSpec: WireframeKindSpec | undefined = owner && WIREFRAME_KINDS[owner.kind];

		if (rest === "-" || rest.startsWith("- ")) {
			if (!within) {
				if (parent && "item" in parent) {
					reject("An item cannot contain other lines.");
					continue;
				}
				if (ownerSpec?.children !== "items") {
					reject(`${owner ? owner.kind : "The top level"} cannot contain "- item" lines.`);
					continue;
				}
			}
			let item = readItem(rest.slice(1).trim());
			if (typeof item !== "string") {
				reject(item.problem);
				continue;
			}
			if (within || !owner) {
				stack.push({ width, rejected: true });
				continue;
			}
			if (++parts > MAX_WIREFRAME_NODES) {
				problems.push({ line: number, message: tooMany() });
				break;
			}
			owner.items.push({ text: item, span: { start: number, end: number } });
			stretch(stack, number);
			stack.push({ width, item: true });
			continue;
		}

		if (!within) {
			if (parent && "item" in parent) {
				reject("An item cannot contain other lines.");
				continue;
			}
			if (owner && ownerSpec?.children === "none") {
				reject(`${owner.kind} cannot contain other parts.`);
				continue;
			}
			if (owner && ownerSpec?.children === "items") {
				reject(`${owner.kind} contains only "- item" lines.`);
				continue;
			}
			if (width / 2 + 1 > MAX_WIREFRAME_DEPTH) {
				reject(`Parts can nest at most ${MAX_WIREFRAME_DEPTH} levels deep.`);
				continue;
			}
		}

		let node = readNode(rest, number);
		if ("problem" in node) {
			reject(node.problem);
			continue;
		}
		if (within) {
			stack.push({ width, rejected: true });
			continue;
		}
		if (node.id !== undefined) {
			let first = ids.get(node.id);
			if (first !== undefined) {
				reject(`The id "${node.id}" is already used on line ${first}.`);
				continue;
			}
		}
		if (++parts > MAX_WIREFRAME_NODES) {
			problems.push({ line: number, message: tooMany() });
			break;
		}
		if (node.id !== undefined) ids.set(node.id, number);
		(owner ? owner.children : nodes).push(node);
		stretch(stack, number);
		stack.push({ width, node });
	}

	if (!problems.length && !nodes.length) {
		problems.push({ line: 1, message: "The wireframe is empty." });
	}
	if (!problems.length) problems.push(...check({ nodes }));
	if (problems.length) {
		problems.sort((a, b) => a.line - b.line);
		return { ok: false, problems: problems.slice(0, MAX_WIREFRAME_PROBLEMS) };
	}
	return { ok: true, wireframe: { nodes } };
}

/** The one part a note points at, or nothing when it is missing or ambiguous. */
export function resolveWireframeTarget(
	wireframe: Wireframe,
	target: string,
): WireframeNode | undefined {
	let found = locate(index(wireframe), target);
	return "node" in found ? found.node : undefined;
}

type Index = { ids: Map<string, WireframeNode>; kinds: Map<string, WireframeNode[]> };

function index(wireframe: Wireframe): Index {
	let ids = new Map<string, WireframeNode>();
	let kinds = new Map<string, WireframeNode[]>();
	let visit = (node: WireframeNode) => {
		if (node.id !== undefined && !ids.has(node.id)) ids.set(node.id, node);
		let same = kinds.get(node.kind);
		if (same) same.push(node);
		else kinds.set(node.kind, [node]);
		node.children.forEach(visit);
	};
	wireframe.nodes.forEach(visit);
	return { ids, kinds };
}

function locate(index: Index, target: string): { node: WireframeNode } | { problem: string } {
	let node: WireframeNode | undefined;
	if (target.startsWith("#")) {
		node = index.ids.get(target.slice(1));
		if (!node) return { problem: `No part has the id "${show(target.slice(1))}".` };
	} else {
		if (!isWireframeKind(target)) return { problem: `Unknown target "${show(target)}".` };
		let matches = index.kinds.get(target) ?? [];
		if (!matches.length) return { problem: `No ${target} to point at.` };
		if (matches.length > 1) {
			return { problem: `${matches.length} parts are a ${target}; give the target an #id.` };
		}
		node = matches[0]!;
	}
	if (node.kind === "note") return { problem: "A note cannot point at a note." };
	return { node };
}

/** Checks that need the whole tree: note targets and counts against items. */
function check(wireframe: Wireframe): WireframeProblem[] {
	let problems: WireframeProblem[] = [];
	let found = index(wireframe);
	let visit = (node: WireframeNode) => {
		let line = node.span.start;
		if (node.target !== undefined) {
			let target = locate(found, node.target);
			if ("problem" in target) problems.push({ line, message: target.problem });
		}
		let props = WIREFRAME_KINDS[node.kind].props as Record<string, unknown>;
		for (let [key, value] of Object.entries(node.props)) {
			if (props[key] === "count" && Number(value) > node.items.length) {
				problems.push({
					line,
					message: `${key}=${value} but ${node.kind} has ${node.items.length} items.`,
				});
			}
		}
		node.children.forEach(visit);
	};
	wireframe.nodes.forEach(visit);
	return problems;
}

function stretch(stack: readonly Frame[], line: number) {
	for (let frame of stack) if ("node" in frame) frame.node.span.end = line;
}

function tooMany(): string {
	return `The wireframe has more than ${MAX_WIREFRAME_NODES} parts.`;
}

/** Echo at most a short prefix of a token the author wrote. */
function show(token: string): string {
	return token.length > 24 ? `${token.slice(0, 24)}…` : token;
}

function readItem(text: string): string | { problem: string } {
	if (!text) return { problem: 'An item needs text after "- ".' };
	if (text.startsWith('"')) {
		let quoted = readQuoted(text, 0);
		if ("problem" in quoted) return quoted;
		if (quoted.end !== text.length) return { problem: "Expected nothing after the quoted item." };
		return quoted.value;
	}
	return checkText(text) ?? text;
}

function checkText(text: string): { problem: string } | undefined {
	if (!text.trim()) return { problem: "A label cannot be empty." };
	if (text.length > MAX_WIREFRAME_LABEL) {
		return { problem: `Text is longer than ${MAX_WIREFRAME_LABEL} characters.` };
	}
	if (CONTROL_CHARACTER.test(text)) {
		return { problem: "Text cannot contain control characters." };
	}
	return undefined;
}

/** Read a quoted string starting at `start`; `end` is the index after the closing quote. */
function readQuoted(
	line: string,
	start: number,
): { value: string; end: number } | { problem: string } {
	let value = "";
	for (let at = start + 1; at < line.length; at++) {
		let char = line[at]!;
		if (char === '"') {
			if (at + 1 < line.length && line[at + 1] !== " ") {
				return { problem: "Expected a space after the closing quote." };
			}
			let problem = checkText(value.replaceAll("\n", " "));
			return problem ?? { value, end: at + 1 };
		}
		if (char === "\\") {
			let next = line[++at];
			if (next === undefined) break;
			if (next === '"' || next === "\\") value += next;
			else if (next === "n") value += "\n";
			else return { problem: `Unknown escape "\\${show(next)}". Use \\", \\\\ or \\n.` };
			continue;
		}
		if (CONTROL_CHARACTER.test(char)) {
			return { problem: "Text cannot contain control characters." };
		}
		value += char;
		if (value.length > MAX_WIREFRAME_LABEL) {
			return { problem: `Text is longer than ${MAX_WIREFRAME_LABEL} characters.` };
		}
	}
	return { problem: "A label is missing its closing quote." };
}

const ID = /^[A-Za-z][\w-]*$/;

function readNode(line: string, number: number): WireframeNode | { problem: string } {
	let kind = /^[a-z]+(?= |$)/.exec(line)?.[0];
	if (!kind) {
		let word = /^[a-z]+/.exec(line)?.[0];
		if (!word) return { problem: 'Expected a kind or a "- item" line.' };
		return { problem: `Unknown kind "${show(/^\S*/.exec(line)![0])}".` };
	}
	if (!isWireframeKind(kind)) return { problem: `Unknown kind "${show(kind)}".` };
	let spec: WireframeKindSpec = WIREFRAME_KINDS[kind];
	let node: WireframeNode = {
		kind,
		flags: [],
		props: {},
		children: [],
		items: [],
		span: { start: number, end: number },
	};

	let at = kind.length;
	let word = (): string => {
		let end = line.indexOf(" ", at);
		if (end < 0) end = line.length;
		let token = line.slice(at, end);
		at = end;
		return token;
	};
	while (at < line.length) {
		if (line[at] === " ") {
			at++;
			continue;
		}
		let char = line[at];
		if (char === '"') {
			if (node.label !== undefined) return { problem: `${kind} has more than one label.` };
			if (spec.label === "none") return { problem: `${kind} does not take a label.` };
			let quoted = readQuoted(line, at);
			if ("problem" in quoted) return quoted;
			node.label = quoted.value;
			at = quoted.end;
			continue;
		}
		if (char === "#") {
			if (node.id !== undefined) return { problem: `${kind} has more than one id.` };
			let id = word().slice(1);
			if (!ID.test(id)) {
				return { problem: "An id is # followed by a letter, then letters, digits, - or _." };
			}
			if (id.length > MAX_WIREFRAME_ID) {
				return { problem: `An id is at most ${MAX_WIREFRAME_ID} characters.` };
			}
			node.id = id;
			continue;
		}
		if (line.startsWith("->", at) && (at + 2 === line.length || line[at + 2] === " ")) {
			if (!spec.target) return { problem: "Only a note points at a target." };
			if (node.target !== undefined) return { problem: `${kind} has more than one target.` };
			at += 2;
			while (line[at] === " ") at++;
			let target = word();
			if (!target) return { problem: 'Expected a target after "->".' };
			if (target.startsWith("#") ? !ID.test(target.slice(1)) : !isWireframeKind(target)) {
				return { problem: `Unknown target "${show(target)}".` };
			}
			if (target === "note") return { problem: "A note cannot point at a note." };
			node.target = target;
			continue;
		}
		let key = /^([a-z]+)=/.exec(line.slice(at, at + 32))?.[1];
		if (key) {
			if (!Object.hasOwn(spec.props, key)) return { problem: `${kind} does not accept "${key}".` };
			if (Object.hasOwn(node.props, key)) return { problem: `The property "${key}" is repeated.` };
			at += key.length + 1;
			let value: string;
			if (line[at] === '"') {
				let quoted = readQuoted(line, at);
				if ("problem" in quoted) return quoted;
				value = quoted.value;
				at = quoted.end;
			} else {
				value = word();
				if (!value) return { problem: `${key} needs a value.` };
				if (value.includes('"')) return { problem: `Unexpected "${show(value)}".` };
				let problem = checkText(value);
				if (problem) return problem;
			}
			let allowed = spec.props[key]!;
			if (allowed === "count" && !/^[1-9]\d{0,2}$/.test(value)) {
				return { problem: `${key} must be a whole number from 1.` };
			}
			if (typeof allowed !== "string" && !allowed.includes(value)) {
				return { problem: `${key} must be one of: ${allowed.join(", ")}.` };
			}
			node.props[key] = value;
			continue;
		}
		let token = word();
		if (!/^[a-z]+$/.test(token)) return { problem: `Unexpected "${show(token)}".` };
		if (!spec.flags.includes(token)) {
			let allowed = spec.flags.length ? ` Allowed: ${spec.flags.join(", ")}.` : "";
			return { problem: `${kind} does not accept the flag "${show(token)}".${allowed}` };
		}
		if (node.flags.includes(token)) return { problem: `The flag "${token}" is repeated.` };
		node.flags.push(token);
	}

	if (spec.label === "required" && node.label === undefined) {
		return { problem: `${kind} needs a quoted label.` };
	}
	if (spec.target && node.target === undefined) {
		return { problem: `${kind} needs a target: -> #id or -> kind.` };
	}
	return node;
}
