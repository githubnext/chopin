import { HIDDEN_URL_CHARACTERS } from "@chopin/dialect";
import { createLibrary, createParser, defineComponent } from "@openuidev/react-lang";
import type { ElementNode } from "@openuidev/react-lang";
import { z } from "zod";

export type OptionMedia =
	| { kind: "image"; url: string; alt: string; caption: string }
	| { kind: "preview"; text: string; caption: string };

export type OptionModel = {
	id: string;
	title: string;
	strength: string;
	tradeoff: string;
	detail: string;
	category: string;
	media: OptionMedia;
};

export type ViewModel = {
	kind: "gallery" | "comparison" | "details";
	title: string;
	layout?: "grid" | "rail";
	options: OptionModel[];
};

export type OptionsSectionModel = {
	title: string;
	introduction: string;
	views: ViewModel[];
};

type Value = string | string[];
type Declaration = { component: string; args: Value[] };

const id = z.string().min(1).max(24).regex(/^[a-z0-9-]+$/);
const title = (max: number) => z.string().min(1).max(max);
const imageUrl = z.string().max(2_048).refine(value => {
	if (HIDDEN_URL_CHARACTERS.test(value) || /\s/.test(value)) return false;
	try {
		let parsed = new URL(value);
		return parsed.protocol === "https:" && Boolean(parsed.hostname);
	} catch {
		return false;
	}
});

const imageProps = z.object({
	url: imageUrl,
	alt: z.string().min(1).max(180),
	caption: z.string().min(1).max(100),
});
const previewProps = z.object({
	text: z.string().min(1).max(240),
	caption: z.string().min(1).max(100),
});

const OptionImage = defineComponent({
	name: "OptionImage",
	description: "Image preview",
	props: imageProps,
	component: () => null,
});
const OptionPreview = defineComponent({
	name: "OptionPreview",
	description: "Plain text preview",
	props: previewProps,
	component: () => null,
});

const optionValueProps = z.object({
	id,
	title: title(70),
	strength: z.string().min(1).max(180),
	tradeoff: z.string().min(1).max(180),
	detail: z.string().min(1).max(500),
	category: z.string().min(1).max(32),
	media: z.unknown(),
});
const optionProps = optionValueProps.extend({
	media: z.union([OptionImage.ref, OptionPreview.ref]),
});
const DesignOption = defineComponent({
	name: "DesignOption",
	description: "One alternative",
	props: optionProps,
	component: () => null,
});

const galleryValueProps = z.object({
	title: title(70),
	layout: z.enum(["grid", "rail"]),
	options: z.array(z.unknown()).min(2).max(6),
});
const viewValueProps = z.object({
	title: title(70),
	options: z.array(z.unknown()).min(2).max(6),
});
const galleryProps = galleryValueProps.extend({
	options: z.array(DesignOption.ref).min(2).max(6),
});
const comparisonProps = viewValueProps.extend({
	options: z.array(DesignOption.ref).min(2).max(6),
});
const detailsProps = viewValueProps.extend({
	options: z.array(DesignOption.ref).min(2).max(6),
});
const OptionGallery = defineComponent({
	name: "OptionGallery",
	description: "Option previews",
	props: galleryProps,
	component: () => null,
});
const OptionComparison = defineComponent({
	name: "OptionComparison",
	description: "Comparison table",
	props: comparisonProps,
	component: () => null,
});
const OptionDetails = defineComponent({
	name: "OptionDetails",
	description: "Option details",
	props: detailsProps,
	component: () => null,
});

const sectionValueProps = z.object({
	title: title(90),
	introduction: z.string().min(1).max(240),
	views: z.array(z.unknown()).length(3),
});
const sectionProps = sectionValueProps.extend({
	views: z.array(z.union([OptionGallery.ref, OptionComparison.ref, OptionDetails.ref])).length(3),
});
const OptionsSection = defineComponent({
	name: "OptionsSection",
	description: "Comparison section",
	props: sectionProps,
	component: () => null,
});

export const openUIOptionsLibrary = createLibrary({
	components: [
		OptionsSection,
		OptionGallery,
		OptionComparison,
		OptionDetails,
		DesignOption,
		OptionImage,
		OptionPreview,
	],
	root: "OptionsSection",
});

const parser = createParser(openUIOptionsLibrary.toJSONSchema());
const viewComponents = {
	gallery: "OptionGallery",
	comparison: "OptionComparison",
	details: "OptionDetails",
} as const;

function invalid(message: string): never {
	throw new Error(message);
}

/** Read only JSON strings, bare references, and lists of bare references. */
function readArguments(input: string): Value[] {
	let position = 0;
	let values: Value[] = [];
	let space = () => {
		while (input[position] === " " || input[position] === "\t") position++;
	};
	let reference = () => {
		let match = /^[a-z][a-z0-9]*/.exec(input.slice(position));
		if (!match) invalid("Unsupported source expression or reference.");
		position += match[0].length;
		return match[0];
	};
	let string = () => {
		let start = position++;
		while (position < input.length) {
			if (input[position] === "\\") {
				position += 2;
				continue;
			}
			if (input[position++] === '"') {
				try {
					return JSON.parse(input.slice(start, position)) as string;
				} catch {
					invalid("OpenUI parse failure: invalid quoted string.");
				}
			}
		}
		invalid("OpenUI parse failure: unfinished quoted string.");
	};
	space();
	if (!input.slice(position)) return values;
	while (position < input.length) {
		space();
		if (input[position] === '"') values.push(string());
		else if (input[position] === "[") {
			position++;
			let refs: string[] = [];
			space();
			while (input[position] !== "]") {
				refs.push(reference());
				space();
				if (input[position] === "]") break;
				if (input[position++] !== ",") invalid("Unsupported source expression or reference list.");
				space();
				if (input[position] === "]") invalid("OpenUI parse failure: trailing comma.");
				if (position >= input.length) invalid("OpenUI parse failure: unfinished reference list.");
			}
			position++;
			values.push(refs);
		} else values.push(reference());
		space();
		if (position >= input.length) break;
		if (input[position++] !== ",") invalid("Unsupported source expression or statement.");
		space();
		if (position >= input.length) invalid("OpenUI parse failure: trailing comma.");
	}
	return values;
}

function declarations(source: string): Map<string, Declaration> {
	let output = new Map<string, Declaration>();
	for (let line of source.replaceAll("\r\n", "\n").split("\n")) {
		let match = /^([a-z][a-z0-9]*)\s*=\s*([A-Z][A-Za-z]*)\((.*)\)$/.exec(line);
		if (!match) invalid("Unsupported declaration or statement: use one declaration per line.");
		let [, name, component, argumentsSource] = match;
		if (output.has(name!)) invalid(`Duplicate declaration: ${name}.`);
		let expected = name === "root"
			? "OptionsSection"
			: name === "gallery" || name === "comparison" || name === "details"
			? viewComponents[name]
			: /^option[1-6]$/.test(name!)
			? "DesignOption"
			: /^media[1-6]$/.test(name!)
			? "media"
			: undefined;
		if (!expected) invalid(`Unsupported declaration: ${name}.`);
		if (
			expected === "media"
				? component !== "OptionImage" && component !== "OptionPreview"
				: component !== expected
		) invalid(`Unsupported component: ${component}.`);
		output.set(name!, { component: component!, args: readArguments(argumentsSource!) });
	}
	return output;
}

function references(value: Value | undefined, expected: readonly string[], label: string): void {
	if (
		!Array.isArray(value) || value.length !== expected.length
		|| new Set(value).size !== expected.length
		|| value.some(ref => !expected.includes(ref))
	) {
		invalid(`Missing, duplicate, or mismatched references in ${label}.`);
	}
}

function node(value: unknown, component: string, name: string): ElementNode {
	if (
		!value || typeof value !== "object" || !("type" in value) || value.type !== "element"
		|| !("typeName" in value) || value.typeName !== component
		|| ("partial" in value && value.partial)
		|| !("statementId" in value) || value.statementId !== name
		|| !("props" in value) || !value.props || typeof value.props !== "object"
	) {
		invalid(`Missing or mismatched reference: ${name}.`);
	}
	return value as ElementNode;
}

function fields<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
	let parsed = schema.safeParse(value);
	if (!parsed.success) {
		let field = parsed.error.issues[0]?.path.join(".") || "value";
		if (label.startsWith("media") && field === "url") invalid(`Invalid image URL in ${label}.`);
		invalid(`Invalid field in ${label}: ${field}.`);
	}
	return parsed.data;
}

export function parseOptionsSource(
	source: string,
): { section: OptionsSectionModel } | { error: string } {
	try {
		if (!source || !source.trim()) invalid("Missing OpenUI source.");
		if (source.length > 12_000) invalid("OpenUI source exceeds 12,000 characters.");
		let declared = declarations(source);
		let count = [...declared.keys()].filter(name => /^option[1-6]$/.test(name)).length;
		if (count < 2 || count > 6) invalid("An options section needs 2–6 options.");
		let names = Array.from({ length: count }, (_, index) => `option${index + 1}`);
		let mediaNames = names.map((_, index) => `media${index + 1}`);
		if (
			declared.size !== 4 + count * 2
			|| !["root", "gallery", "comparison", "details", ...names, ...mediaNames]
				.every(name => declared.has(name))
		) invalid("Missing or unsupported declaration.");
		references(declared.get("root")!.args[2], ["gallery", "comparison", "details"], "root");
		for (let view of ["gallery", "comparison", "details"] as const) {
			references(declared.get(view)!.args[view === "gallery" ? 2 : 1], names, view);
		}
		for (let index = 0; index < count; index++) {
			if (declared.get(names[index]!)!.args[6] !== mediaNames[index]) {
				invalid(`Option ${index + 1} needs its matching media reference.`);
			}
		}
		let parsed = parser.parse(source);
		if (
			!parsed.root || parsed.root.partial || parsed.meta.incomplete || parsed.meta.errors.length
			|| parsed.meta.unresolved.length || parsed.meta.orphaned.length
			|| parsed.meta.statementCount !== declared.size
			|| Object.keys(parsed.stateDeclarations).length || parsed.queryStatements.length
			|| parsed.mutationStatements.length
		) invalid("OpenUI parse failure or unsupported runtime statements.");
		let root = node(parsed.root, "OptionsSection", "root");
		let section = fields(sectionValueProps, root.props, "section");
		let views: ViewModel[] = section.views.map((value, viewIndex) => {
			let name = (declared.get("root")!.args[2] as string[])[viewIndex]!;
			let viewNode = node(value, viewComponents[name as keyof typeof viewComponents], name);
			let view = name === "gallery"
				? fields(galleryValueProps, viewNode.props, name)
				: fields(viewValueProps, viewNode.props, name);
			let options: OptionModel[] = view.options.map((optionValue, optionIndex) => {
				let optionName =
					(declared.get(name)!.args[name === "gallery" ? 2 : 1] as string[])[optionIndex]!;
				let optionNode = node(optionValue, "DesignOption", optionName);
				let option = fields(optionValueProps, optionNode.props, optionName);
				let mediaName = `media${optionName.slice(6)}`;
				let mediaNode = node(option.media, declared.get(mediaName)!.component, mediaName);
				let media: OptionMedia = mediaNode.typeName === "OptionImage"
					? { kind: "image", ...fields(imageProps, mediaNode.props, mediaName) }
					: { kind: "preview", ...fields(previewProps, mediaNode.props, mediaName) };
				return {
					id: option.id,
					title: option.title,
					strength: option.strength,
					tradeoff: option.tradeoff,
					detail: option.detail,
					category: option.category,
					media,
				};
			});
			return name === "gallery"
				? {
					kind: "gallery",
					title: view.title,
					layout: (view as z.infer<typeof galleryValueProps>).layout,
					options,
				}
				: { kind: name as "comparison" | "details", title: view.title, options };
		});
		let ids = views[0]!.options.map(option => option.id);
		if (new Set(ids).size !== ids.length) invalid("Duplicate option ID.");
		return { section: { title: section.title, introduction: section.introduction, views } };
	} catch (error) {
		return { error: error instanceof Error ? error.message : "OpenUI parse failure." };
	}
}
