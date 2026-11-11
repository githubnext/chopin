/**
 * The assistant-ui layer: what lets copied registry components keep their own Tailwind classes and
 * look as they do upstream, inside an app whose theme rewrites Tailwind's scale.
 *
 * Chopin's theme resets Tailwind's `--radius-*`, `--text-*`, `--shadow-*`, `--ease-*` and colours and
 * declares its own `--spacing`, weights and transition defaults, so `rounded-xl` is 10px, `text-sm`
 * fluid, and `rounded-2xl`, `shadow-md` and `ease-in` do not exist. A copied class cannot change, so
 * the values do. This writes one stylesheet from two inputs and invents nothing:
 *
 *   - Tailwind's own `theme.css`, for every variable Chopin's theme changes or drops;
 *   - the `data-slot` of every element in the recorded sources, which is where the copies set them.
 *
 * Variables Chopin dropped are declared in `@theme static` so their utilities exist. All of them, the
 * ones Chopin changed included, are set again on the copies' own roots (`data-slot` scope), which is
 * also where a popup portalled to `<body>` can be found. Chopin's elements are never in that scope,
 * so its scale is untouched. The stylesheet also holds the two rules that keep Chopin's global
 * button behaviour out of a copy, and the invisible touch target. It is recorded as third-party
 * source (`tailwindcss/theme.css`), so `bun scripts/record-registry-sources.ts` writes it and the
 * design contract does not read it as Chopin's own CSS; its test regenerates it byte for byte.
 */

import postcss from "postcss";

export const LAYER_FILE = "apps/web/src/components/geometry.css";

/** The variables a copied class can read geometry from; colours and fonts are not geometry. */
const GEOMETRY =
	/^--(spacing|radius-.+|text-.+|font-weight-.+|tracking-.+|leading-.+|shadow-.+|inset-shadow-.+|drop-shadow-.+|ease-.+|default-transition-(duration|timing-function))$/;

/** What a touch target can be, inside a copy: one of these is what a finger aims at. */
const TARGETS = [
	"button",
	'[role="button"]',
	'[role="checkbox"]',
	'[role="combobox"]',
	'[role="menuitem"]',
	'[role="option"]',
	'[role="radio"]',
	'[role="switch"]',
	'[role="tab"]',
	"a[href]",
];

type Variable = [name: string, value: string];

/**
 * A Chopin control put inside a copy through a patch slot carries this attribute and is Chopin's
 * again: its focus ring, press and transition, touch rules and scale are not the copy's.
 */
const OWN = ":not([data-chopin-control])";

function declarations(css: string, within: (rule: postcss.AtRule) => boolean): Variable[] {
	let found: Variable[] = [];
	postcss.parse(css).walkAtRules("theme", rule => {
		if (!within(rule)) return;
		for (let node of rule.nodes ?? []) {
			if (node.type === "decl" && node.prop.startsWith("--")) found.push([node.prop, node.value]);
		}
	});
	return found;
}

export type LayerInput = {
	/** Tailwind's `theme.css`. */
	tailwind: string;
	/** Chopin's theme (`packages/visuals/theme.css`). */
	chopin: string;
	/** The `data-slot` values the recorded sources set. */
	slots: readonly string[];
};

/** The `data-slot="…"` strings in some source, which is how every copied root names itself. */
export function slotsOf(source: string): string[] {
	return [...source.matchAll(/data-slot="([\w-]+)"/g)].map(match => match[1]!);
}

function lines(items: readonly Variable[]): string {
	return items.map(([name, value]) => `\t${name}: ${value};`).join("\n");
}

/** `:is(a, b)` with one selector a line, its closing parenthesis `depth` tabs in. */
function is(items: readonly string[], depth = 0): string {
	let pad = "\t".repeat(depth + 1);
	return `:is(\n${pad}${items.join(`,\n${pad}`)}\n${"\t".repeat(depth)})`;
}

/**
 * Tailwind's shadows are black at some opacity. A colour is Chopin's, so each is Chopin's shadow
 * tint (`--shadow-color`) at the same opacity.
 */
export function tinted(value: string): string {
	return value.replace(/rgb\(0 0 0 \/ ([\d.]+)\)/g, "oklch(var(--shadow-color) / $1)");
}

export function layerCss({ tailwind, chopin, slots }: LayerInput): string {
	let wanted = declarations(tailwind, rule => rule.params === "default")
		.filter(([name]) => GEOMETRY.test(name))
		.map(([name, value]): Variable => [name, /shadow/.test(name) ? tinted(value) : value]);
	let own = declarations(chopin, () => true);
	let declared = new Set(own.map(([name]) => name));
	let resets = own.filter(([name, value]) => name.endsWith("-*") && value === "initial")
		.map(([name]) => name.slice(0, -1));
	// Everything Chopin's theme changed or dropped. What it left alone is already Tailwind's.
	let touched = wanted.filter(([name]) =>
		declared.has(name) || resets.some(prefix => name.startsWith(prefix))
	);
	let dropped = touched.filter(([name]) => !declared.has(name));
	let chopinValue = new Map(own);
	// Chopin's own value of each variable the roots restored, for a control of Chopin's inside one.
	let theirs = touched.filter(([name]) => declared.has(name)).map(([name]): Variable => [
		name,
		chopinValue.get(name)!,
	]);
	let roots = [...new Set(slots)].sort().map(slot => `[data-slot="${slot}"]`);
	let copies = (depth: number) => is(roots, depth);
	let aimed = (depth: number) => `${is(TARGETS, depth)}${OWN}`;
	// A target that is a copy's root, and one inside it.
	let targets = (depth: number) =>
		`${copies(depth)}${aimed(depth)},\n${"\t".repeat(depth)}${copies(depth)} ${aimed(depth)}`;

	return `/*
 * Generated by \`bun scripts/record-registry-sources.ts\`; recorded as third-party source. Do not edit.
 * See scripts/assistant-ui-layer.ts for what is in it and why.
 */

/* Dropped by Chopin's theme: declared again so their utilities exist. */
@theme static {
${lines(dropped)}
}

/*
 * Tailwind's own values, on the copies' roots. Chopin's elements are never inside one. A bare
 * \`border\` draws shadcn's border colour there: preflight reads \`--color-gray-200\` for it, which
 * is inherited, so one declaration on the root reaches every descendant (a rule on \`*\` would make
 * the browser walk every element's ancestors on each style recalculation).
 */
:where(
${roots.map(root => `\t${root}`).join(",\n")}
) {
${lines(touched)}
\t--color-gray-200: var(--color-border);
}

/*
 * A Chopin control in a copy's slot (\`data-chopin-control\`) is Chopin's again: the variables above
 * return to Chopin's values for it, and the rules below leave it alone.
 */
:where([data-chopin-control]) {
${lines(theirs)}
\t--color-gray-200: ${chopinValue.get("--color-gray-200")};
}

/*
 * Chopin's global button rules are unlayered and so beat a copy's utilities: a transition that is
 * only \`scale\`, a press that scales, and a focus outline beside the copy's own ring. A copy keeps
 * what it declares.
 */
${targets(0)} {
	transition: revert-layer;
}

${copies(0)}:is(button, [role="button"])${OWN}:active,
${copies(0)} :is(button, [role="button"])${OWN}:active {
	scale: revert-layer;
}

${copies(0)}:focus-visible${OWN},
${copies(0)} :focus-visible${OWN} {
	outline: revert-layer;
	outline-offset: revert-layer;
}

/*
 * A small control keeps its look; an invisible target of the coarse size grows around it, so the
 * visible box is the same on touch. In the components layer so utilities such as \`absolute\` win.
 */
@layer components {
	:root[data-plan-coarse-pointer] :where(
		${targets(2)}
	) {
		position: relative;
	}

	:root[data-plan-coarse-pointer] :where(
		${targets(2)}
	)::after {
		content: "";
		position: absolute;
		top: 50%;
		left: 50%;
		width: max(100%, var(--control-target-coarse));
		height: max(100%, var(--control-target-coarse));
		transform: translate(-50%, -50%);
	}
}
`;
}
