import { Component } from "react";
import { createLibrary, createParser, defineComponent, Renderer } from "@openuidev/react-lang";
import { z } from "zod/v4";

import {
	DesignOption,
	OptionComparison,
	OptionDetails,
	OptionGallery,
	OptionsSection,
} from "./openui-options-components";

import type { ElementNode } from "@openuidev/react-lang";
import type { ReactNode } from "react";

const Option = defineComponent({
	name: "DesignOption",
	description: "One design option reused as a gallery card, comparison row, and expandable detail.",
	props: z.object({
		id: z.enum(["a", "b", "c"]),
		title: z.string().min(1).max(70),
		strength: z.string().min(1).max(180),
		tradeoff: z.string().min(1).max(180),
		detail: z.string().min(1).max(500),
		specimen: z.enum(["current", "plain", "styled"]),
	}),
	component: ({ props }) => <DesignOption option={props} />,
});

const Gallery = defineComponent({
	name: "OptionGallery",
	description: "Gallery of local illustrative specimens; grid or horizontally scrollable rail.",
	props: z.object({
		title: z.string().min(1).max(70),
		layout: z.enum(["grid", "rail"]),
		items: z.array(Option.ref).length(3),
	}),
	component: ({ props, renderNode }) => (
		<OptionGallery title={props.title} layout={props.layout}>
			{renderNode(props.items)}
		</OptionGallery>
	),
});

const Comparison = defineComponent({
	name: "OptionComparison",
	description: "Semantic comparison table using the same option records as the gallery.",
	props: z.object({ title: z.string().min(1).max(70), items: z.array(Option.ref).length(3) }),
	component: ({ props, renderNode }) => (
		<OptionComparison title={props.title}>{renderNode(props.items)}</OptionComparison>
	),
});

const Details = defineComponent({
	name: "OptionDetails",
	description: "Expandable supporting detail using the same option records.",
	props: z.object({ title: z.string().min(1).max(70), items: z.array(Option.ref).length(3) }),
	component: ({ props, renderNode }) => (
		<OptionDetails title={props.title}>{renderNode(props.items)}</OptionDetails>
	),
});

const Section = defineComponent({
	name: "OptionsSection",
	description: "One document section with an ephemeral local filter and three authored views.",
	props: z.object({
		title: z.string().min(1).max(90),
		introduction: z.string().min(1).max(240),
		items: z.array(z.union([Gallery.ref, Comparison.ref, Details.ref])).length(3),
	}),
	component: ({ props, renderNode }) => (
		<OptionsSection title={props.title} introduction={props.introduction}>
			{renderNode(props.items)}
		</OptionsSection>
	),
});

export const openuiOptionsLibrary = createLibrary({
	root: "OptionsSection",
	components: [Section, Gallery, Comparison, Details, Option],
});

const parser = createParser(openuiOptionsLibrary.toJSONSchema(), openuiOptionsLibrary.root);
const quoted = String.raw`"(?:[^"\\]|\\.)*"`;
const optionList =
	"\\[(optionA|optionB|optionC),\\s*(optionA|optionB|optionC),\\s*(optionA|optionB|optionC)\\]";
const sectionList =
	"\\[(gallery|comparison|details),\\s*(gallery|comparison|details),\\s*(gallery|comparison|details)\\]";
const lines: Record<string, RegExp> = {
	root: new RegExp(`^root\\s*=\\s*OptionsSection\\(${quoted},\\s*${quoted},\\s*${sectionList}\\)$`),
	gallery: new RegExp(
		`^gallery\\s*=\\s*OptionGallery\\(${quoted},\\s*"(?:grid|rail)",\\s*${optionList}\\)$`,
	),
	comparison: new RegExp(`^comparison\\s*=\\s*OptionComparison\\(${quoted},\\s*${optionList}\\)$`),
	details: new RegExp(`^details\\s*=\\s*OptionDetails\\(${quoted},\\s*${optionList}\\)$`),
	optionA: new RegExp(
		`^optionA\\s*=\\s*DesignOption\\("a",\\s*${quoted},\\s*${quoted},\\s*${quoted},\\s*${quoted},\\s*"(?:current|plain|styled)"\\)$`,
	),
	optionB: new RegExp(
		`^optionB\\s*=\\s*DesignOption\\("b",\\s*${quoted},\\s*${quoted},\\s*${quoted},\\s*${quoted},\\s*"(?:current|plain|styled)"\\)$`,
	),
	optionC: new RegExp(
		`^optionC\\s*=\\s*DesignOption\\("c",\\s*${quoted},\\s*${quoted},\\s*${quoted},\\s*${quoted},\\s*"(?:current|plain|styled)"\\)$`,
	),
};

function elements(value: unknown): ElementNode[] {
	if (Array.isArray(value)) return value.flatMap(elements);
	if (value && typeof value === "object" && "type" in value && value.type === "element") {
		let element = value as ElementNode;
		return [element, ...Object.values(element.props).flatMap(elements)];
	}
	return [];
}

function literalTree(value: unknown): boolean {
	if (Array.isArray(value)) return value.every(literalTree);
	if (value && typeof value === "object" && "type" in value && value.type === "element") {
		return Object.values((value as ElementNode).props).every(literalTree);
	}
	return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function ordered(text: string, pattern: RegExp, expected: string[]): boolean {
	let match = pattern.exec(text);
	return !!match && match.slice(-3).sort().join(",") === expected.sort().join(",");
}

/** Keep authored statements to local literals and references before invoking the runtime. */
export function validateOptionsSource(source: string): string | undefined {
	if (!source.trim() || source.length > 6000 || source.includes("```")) {
		return "The options source is empty or too large.";
	}
	let statements = source.trimEnd().split(/\r?\n/);
	let names = statements.map(line => /^([A-Za-z][A-Za-z0-9]*)\s*=\s*\S/.exec(line)?.[1]);
	if (
		statements.length !== 7 || names.some(name => !name) || new Set(names).size !== 7
		|| statements.some((line, index) =>
			!Object.hasOwn(lines, names[index]!)
			|| !lines[names[index]!]!.test(line)
		)
	) {
		return "The options section needs seven supported declarations.";
	}
	if (
		!ordered(statements.find(line => line.startsWith("root"))!, lines.root!, [
			"gallery",
			"comparison",
			"details",
		])
		|| ["gallery", "comparison", "details"].some(name =>
			!ordered(
				statements.find(line => line.startsWith(name))!,
				lines[name]!,
				["optionA", "optionB", "optionC"],
			)
		)
	) return "Each view must use the three distinct option records.";

	let parsed;
	try {
		parsed = parser.parse(source);
	} catch {
		return "The options source could not be parsed.";
	}
	if (
		!parsed.root || parsed.root.typeName !== "OptionsSection" || parsed.root.partial
		|| parsed.meta.incomplete || parsed.meta.errors.length || parsed.meta.unresolved.length
		|| parsed.meta.orphaned.length || parsed.meta.statementCount !== 7
		|| parsed.queryStatements.length || parsed.mutationStatements.length
		|| Object.keys(parsed.stateDeclarations).length || !literalTree(parsed.root)
	) {
		return "The options source uses an unsupported OpenUI statement.";
	}
	let tree = elements(parsed.root);
	let count = (name: string) => tree.filter(node => node.typeName === name).length;
	if (
		count("OptionsSection") !== 1 || count("OptionGallery") !== 1
		|| count("OptionComparison") !== 1 || count("OptionDetails") !== 1
		|| count("DesignOption") !== 9
	) {
		return "The options source has an unsupported composition.";
	}
	return undefined;
}

export function OpenUIOptionsPreview({ source }: { source: string }) {
	let error = validateOptionsSource(source);
	if (error) {
		return (
			<div className="openui-options-error" data-plan-error="">{error} Source is preserved.</div>
		);
	}
	return (
		<div contentEditable={false} data-openui-options-preview="">
			<OptionsRenderBoundary key={source}>
				<Renderer
					response={source}
					library={openuiOptionsLibrary}
					isStreaming={false}
					publishObservability={false}
				/>
			</OptionsRenderBoundary>
		</div>
	);
}

class OptionsRenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override render() {
		return this.state.failed
			? (
				<div className="openui-options-error" data-plan-error="">
					The options could not be drawn. Source is preserved.
				</div>
			)
			: this.props.children;
	}
}
