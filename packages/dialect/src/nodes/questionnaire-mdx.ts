import { attribute, attributes, identity } from "./shared";
import type { Jsx } from "./shared";
import type { MdxJsxFlowElement } from "mdast-util-mdx-jsx";
import {
	type CardStatus,
	type Criterion,
	type Marks,
	type Option,
	parse,
	type Question,
	type Questionnaire,
} from "./questionnaire-fields";

// Exact archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 node declarations; import/export wrappers only.

function elements(node: Jsx, name: string): MdxJsxFlowElement[] {
	let out: MdxJsxFlowElement[] = [];
	for (let child of node.children) {
		if (child.type === "mdxJsxFlowElement" && child.name === name) out.push(child);
	}
	return out;
}

/** `option/criterion:mark` tokens. Neither id contains whitespace or `:`; criteria have no `/`. */
function encodeMarks(marks: Marks): string | undefined {
	let tokens = Object.entries(marks).map(([cell, mark]) => `${cell}:${mark}`);
	return tokens.length ? tokens.join(" ") : undefined;
}

function decodeMarks(value: string | undefined): Marks | undefined {
	if (value === undefined) return undefined;
	let marks: Marks = {};
	for (let token of value.split(/\s+/).filter(Boolean)) {
		let colon = token.lastIndexOf(":");
		if (colon < 1) throw new Error("invalid questionnaire marks");
		marks[token.slice(0, colon)] = token.slice(colon + 1) as "yes";
	}
	return marks;
}

export function fromElement(node: Jsx): Questionnaire {
	let questions: Question[] = [];

	for (let element of elements(node, "Question")) {
		let options: Option[] = [];
		for (let source of elements(element, "Option")) {
			let option: Option = {
				id: attribute(source, "id") ?? "",
				label: attribute(source, "label") ?? "",
			};
			let description = attribute(source, "description");
			if (description) option.description = description;
			options.push(option);
		}

		let criteria: Criterion[] = elements(element, "Criterion").map(source => ({
			id: attribute(source, "id") ?? "",
			label: attribute(source, "label") ?? "",
		}));

		let question: Question = {
			id: attribute(element, "id") ?? "",
			header: attribute(element, "header") ?? "",
			prompt: attribute(element, "prompt") ?? "",
			...(attribute(element, "description") === undefined
				? {}
				: { description: attribute(element, "description") }),
			multiple: attribute(element, "multiple") === "true",
			...(attribute(element, "response") === undefined
				? {}
				: { response: attribute(element, "response") as "text" }),
			options,
			...(criteria.length ? { criteria } : {}),
		};

		let answer = elements(element, "Answer")[0];
		if (answer) {
			question.answer = attribute(answer, "value") ?? "";
			let marks = decodeMarks(attribute(answer, "marks"));
			if (marks) question.marks = marks;
			let chosen = (attribute(answer, "choices") ?? "").split(/\s+/).filter(Boolean);
			if (chosen.length) question.choices = chosen;
		}

		let previousElements = elements(element, "Previous");
		if (previousElements.length > 1) throw new Error("Question accepts at most one Previous");
		let previous = previousElements[0];
		if (previous) {
			question.previous = {
				choices: (attribute(previous, "choices") ?? "").trim().split(/\s+/).filter(Boolean),
				...(attribute(previous, "value") === undefined
					? {}
					: { value: attribute(previous, "value") }),
				by: attribute(previous, "by") ?? "",
				at: attribute(previous, "at") ?? "",
			};
		}

		questions.push(question);
	}

	let by = attribute(node, "by");
	let at = attribute(node, "at");
	let thread = attribute(node, "thread");
	let status = attribute(node, "status") as CardStatus | undefined;

	return parse({
		id: attribute(node, "id") ?? "",
		questions,
		...(thread === undefined ? {} : { thread }),
		...(status === undefined ? {} : { status }),
		...(by ? { by } : {}),
		...(at ? { at } : {}),
	});
}

export function toElement(value: Questionnaire): MdxJsxFlowElement {
	value = parse(value);
	return {
		type: "mdxJsxFlowElement",
		name: "Questionnaire",
		attributes: identity(value.id, {
			thread: value.thread,
			status: value.status,
			by: value.by,
			at: value.at,
		}),
		children: value.questions.map(question => ({
			type: "mdxJsxFlowElement",
			name: "Question",
			attributes: [
				...identity(question.id),
				{ type: "mdxJsxAttribute" as const, name: "header", value: question.header },
				{ type: "mdxJsxAttribute" as const, name: "prompt", value: question.prompt },
				...attributes({ description: question.description, response: question.response }),
				{ type: "mdxJsxAttribute" as const, name: "multiple", value: String(question.multiple) },
			],
			children: [
				...question.options.map(option => ({
					type: "mdxJsxFlowElement" as const,
					name: "Option",
					attributes: [
						...identity(option.id),
						{ type: "mdxJsxAttribute" as const, name: "label", value: option.label },
						...(option.description
							? [{
								type: "mdxJsxAttribute" as const,
								name: "description",
								value: option.description,
							}]
							: []),
					],
					children: [],
				})),
				...(question.criteria ?? []).map(criterion => ({
					type: "mdxJsxFlowElement" as const,
					name: "Criterion",
					attributes: [
						...identity(criterion.id),
						{ type: "mdxJsxAttribute" as const, name: "label", value: criterion.label },
					],
					children: [],
				})),
				// A projection of sidecar state: addressed through its Question,
				// so it carries no identity of its own.
				...(question.answer === undefined ? [] : [{
					type: "mdxJsxFlowElement" as const,
					name: "Answer",
					attributes: [
						{ type: "mdxJsxAttribute" as const, name: "value", value: question.answer },
						...attributes({
							choices: question.choices?.join(" "),
							marks: question.marks && encodeMarks(question.marks),
						}),
					],
					children: [],
				}]),
				...(question.previous
					? [{
						type: "mdxJsxFlowElement" as const,
						name: "Previous",
						attributes: attributes({
							choices: question.previous.choices.length
								? question.previous.choices.join(" ")
								: undefined,
							value: question.previous.value,
							by: question.previous.by,
							at: question.previous.at,
						}),
						children: [],
					}]
					: []),
			],
		})),
	};
}
