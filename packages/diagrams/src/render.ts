import { resolvePreset } from "./core/motion.mjs";
import { validate } from "./core/schema.mjs";
import { SCHEMAS } from "./core/schemas";
import { ALIASES, TYPES } from "./core/types.mjs";

export type DiagramSpec =
	& { type: string; title?: string; subtitle?: string; caption?: string; motion?: string }
	& Record<string, unknown>;

export type DiagramProblem = { code: string; at: string; msg: string; fix?: string };

export type DiagramGraph = {
	nodes: Array<{ id: string; label: string; group?: string }>;
	edges: Array<{ id: string; from: string; to: string }>;
};

type RendererInfo = {
	name: string;
	family: string;
	schema?: string;
	defaultMotion?: string;
	renderer: {
		render: (spec: DiagramSpec, options: { preset: string; settings: Record<string, unknown> }) => {
			body?: string;
			viewBox?: unknown;
			steps?: unknown;
			problems?: DiagramProblem[];
			graph?: DiagramGraph;
		};
	};
};

export type DiagramResult =
	| {
		ok: true;
		body: string;
		viewBox: [number, number, number, number];
		steps: number;
		motion: string;
		type: string;
		title: string;
		description: string;
		graph?: DiagramGraph;
		diagnostics: DiagramProblem[];
	}
	| { ok: false; problems: DiagramProblem[] };

export const DIAGRAM_TYPES = Object.freeze(
	Object.fromEntries(
		Object.entries(TYPES).map(([slug, info]) => [slug, { name: info.name, family: info.family }]),
	),
) as Readonly<Record<string, { name: string; family: string }>>;

export const DIAGRAM_ALIASES = Object.freeze(
	Object.fromEntries(Object.entries(ALIASES).map(([slug, alias]) => [slug, alias[0]])),
) as Readonly<Record<string, string>>;

const LIMITS = { depth: 12, array: 200, fields: 80, values: 4000, text: 2048, totalText: 50000 };
const INVALID_GEOMETRY =
	/\b(?:x|y|x1|x2|y1|y2|cx|cy|rx|ry|r|width|height|d|transform|style)="[^"]*\b(?:NaN|Infinity|undefined)\b/;

function boundedCopy(input: unknown): { value?: DiagramSpec; problem?: DiagramProblem } {
	let values = 0;
	let text = 0;
	let seen = new WeakSet<object>();
	let problem: DiagramProblem | undefined;
	let walk = (value: unknown, at: string, depth: number): unknown => {
		if (problem) return undefined;
		if (++values > LIMITS.values || depth > LIMITS.depth) {
			problem = { code: "E_LIMIT", at, msg: "diagram specification is too large" };
			return undefined;
		}
		if (typeof value === "string") {
			text += value.length;
			if (value.length > LIMITS.text || text > LIMITS.totalText) {
				problem = { code: "E_LIMIT", at, msg: "diagram text is too long" };
			}
			return value;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
				problem = { code: "E_NUMBER", at, msg: "number must be finite and bounded" };
			}
			return value;
		}
		if (value === null || typeof value === "boolean") return value;
		if (typeof value !== "object") {
			problem = { code: "E_VALUE", at, msg: "only JSON values are allowed" };
			return undefined;
		}
		if (seen.has(value)) {
			problem = { code: "E_VALUE", at, msg: "cyclic values are not allowed" };
			return undefined;
		}
		seen.add(value);
		if (Array.isArray(value)) {
			if (value.length > LIMITS.array) {
				problem = { code: "E_LIMIT", at, msg: "diagram collection is too large" };
				return undefined;
			}
			return value.map((item, index) => walk(item, `${at}[${index}]`, depth + 1));
		}
		if (
			Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null
		) {
			problem = { code: "E_VALUE", at, msg: "only plain objects are allowed" };
			return undefined;
		}
		let descriptors = Object.getOwnPropertyDescriptors(value);
		let entries = Object.entries(descriptors);
		if (entries.length > LIMITS.fields || Object.getOwnPropertySymbols(value).length) {
			problem = { code: "E_LIMIT", at, msg: "diagram object has too many fields" };
			return undefined;
		}
		let copy: Record<string, unknown> = {};
		for (let [key, descriptor] of entries) {
			let path = at ? `${at}.${key}` : key;
			if (
				key === "__proto__" || key === "constructor" || key === "prototype"
				|| !("value" in descriptor)
			) {
				problem = { code: "E_VALUE", at: path, msg: "unsupported object field" };
				return undefined;
			}
			if ((key === "data" || key === "links") && typeof descriptor.value === "string") {
				problem = {
					code: "E_PATH",
					at: path,
					msg: "provide resolved diagram data, not a file path",
				};
				return undefined;
			}
			copy[key] = walk(descriptor.value, path, depth + 1);
		}
		return copy;
	};
	try {
		let value = walk(input, "", 0);
		return problem ? { problem } : { value: value as DiagramSpec };
	} catch {
		return { problem: { code: "E_VALUE", at: "(root)", msg: "diagram input could not be read" } };
	}
}

const FIX_HINTS: Record<string, string> = {
	"is required": "add the field",
	"unknown field": "remove the field",
};

export function renderDiagram(input: unknown): DiagramResult {
	let copied = boundedCopy(input);
	if (copied.problem) return { ok: false, problems: [copied.problem] };
	if (!copied.value || typeof copied.value !== "object" || Array.isArray(copied.value)) {
		return {
			ok: false,
			problems: [{ code: "E_SPEC", at: "(root)", msg: "expected a diagram object" }],
		};
	}
	let spec: DiagramSpec = copied.value;
	let slug = spec.type;
	if (typeof slug !== "string" || !Object.hasOwn(TYPES, slug) && !Object.hasOwn(ALIASES, slug)) {
		return {
			ok: false,
			problems: [{
				code: "E_TYPE",
				at: "type",
				msg: typeof slug === "string"
					? `unknown diagram type ${slug}`
					: "type must be a registered string",
				fix: "choose a registered diagram type",
			}],
		};
	}
	if (Object.hasOwn(spec, "out") || Object.hasOwn(spec, "evidence")) {
		return {
			ok: false,
			problems: [{
				code: "E_PATH",
				at: Object.hasOwn(spec, "out") ? "out" : "evidence",
				msg: "file output and references are not supported",
			}],
		};
	}
	if (spec.style && spec.style !== "clean") {
		return {
			ok: false,
			problems: [{ code: "E_STYLE", at: "style", msg: "only clean diagram style is supported" }],
		};
	}
	if (Object.hasOwn(ALIASES, slug)) {
		let [base, variant, defaults] =
			(ALIASES as unknown as Record<string, [string, string?, Record<string, unknown>?]>)[slug];
		spec = { ...defaults, ...spec, type: base, variant: spec.variant || variant };
		if (spec.variant === undefined) delete spec.variant;
	}
	let info = (TYPES as Record<string, RendererInfo>)[spec.type];
	let schemaName = (info.schema || spec.type) as keyof typeof SCHEMAS;
	let bodySchema = SCHEMAS[schemaName];
	if (!bodySchema) {
		return { ok: false, problems: [{ code: "E_TYPE", at: "type", msg: "schema unavailable" }] };
	}
	let schema = {
		...bodySchema,
		properties: { ...SCHEMAS.common.properties, ...bodySchema.properties },
	};
	let invalid = validate(schema, spec).map((issue: { at: string; msg: string }) => ({
		code: "E_SPEC",
		at: issue.at,
		msg: issue.msg,
		fix: FIX_HINTS[issue.msg] || "fix the value",
	}));
	if (invalid.length) return { ok: false, problems: invalid.slice(0, 20) };
	let motion = resolvePreset(
		spec.motion === "auto" && info.defaultMotion ? info.defaultMotion : spec.motion,
		info.family,
	);
	try {
		let result = info.renderer.render(spec, { preset: motion, settings: {} });
		let diagnostics = ((result.problems || []) as DiagramProblem[]).map((issue) => ({
			...issue,
			at: issue.at || "(root)",
		}));
		let errors = diagnostics.filter((issue) => issue.code.startsWith("E_"));
		if (errors.length || !result.body) {
			return {
				ok: false,
				problems: errors.length
					? errors
					: [{ code: "E_RENDER", at: "(root)", msg: "diagram could not be rendered" }],
			};
		}
		let viewBox = result.viewBox;
		if (
			!Array.isArray(viewBox) || viewBox.length !== 4 || viewBox.some((n: unknown) =>
				typeof n !== "number" || !Number.isFinite(n)
			) || viewBox[2] <= 0 || viewBox[3] <= 0 || typeof result.steps !== "number"
			|| !Number.isInteger(result.steps) || result.steps < 0 || result.steps > 12
			|| INVALID_GEOMETRY.test(result.body)
		) {
			return {
				ok: false,
				problems: [{ code: "E_RENDER", at: "(root)", msg: "renderer produced invalid geometry" }],
			};
		}
		return {
			ok: true,
			body: result.body,
			viewBox: viewBox as [number, number, number, number],
			steps: result.steps,
			motion,
			type: spec.type,
			title: spec.title || info.name,
			description: spec.subtitle || spec.caption || `${info.name} diagram`,
			...(result.graph ? { graph: result.graph as DiagramGraph } : {}),
			diagnostics,
		};
	} catch {
		return {
			ok: false,
			problems: [{
				code: "E_RENDER",
				at: "(root)",
				msg: "diagram renderer failed",
				fix: "simplify the specification",
			}],
		};
	}
}
