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

/** What a press scales. */
const PRESSABLE = ["button", '[role="button"]'];

/** Tailwind's bare border-width utilities: a copy that uses one has a border to colour. */
const BORDERS = [
	"border",
	"border-t",
	"border-r",
	"border-b",
	"border-l",
	"border-x",
	"border-y",
	"border-s",
	"border-e",
];

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
	// A copy's roots by the first word of their `data-slot` (`command` is `command-item` and the rest),
	// which is a handful of selectors for every ancestor lookup to try instead of forty.
	let roots = [...new Set(slots.map(slot => slot.split("-")[0]!))].sort()
		.map(word => `[data-slot|="${word}"]`);
	let copies = (depth: number) => is(roots, depth);
	let borders = BORDERS.flatMap(
		name => [`\t${copies(1)} .${name}${OWN}`, `\t.${name}:is(${roots.join(", ")})${OWN}`],
	)
		.join(",\n");
	/**
	 * One selector for each thing a finger can aim at, inside a copy and as its root, each with its tag,
	 * attribute or pseudo-class as the subject: a subject that every element has (`:is(button, a)`
	 * as one list, `:where(...)`, `*`) is tried on every element on every style recalculation.
	 */
	let aimedAt = (before: string, targets: readonly string[], after = "") =>
		targets.flatMap(target => [
			`${before}${copies(1)} ${target}${OWN}${after}`,
			`${before}${target}:is(${roots.join(", ")})${OWN}${after}`,
		]).join(",\n");

	return `/*
 * Generated by \`bun scripts/record-registry-sources.ts\`; recorded as third-party source. Do not edit.
 * See scripts/assistant-ui-layer.ts for what is in it and why.
 */

/* Dropped by Chopin's theme: declared again so their utilities exist. */
@theme static {
${lines(dropped)}
}

/* Tailwind's own values, on the copies' roots. Chopin's elements are never inside one. */
${roots.join(",\n")} {
${lines(touched)}
}

/*
 * A bare \`border\` draws shadcn's border colour, as its own base layer makes it, and not the text
 * colour Tailwind's preflight leaves it. The subject of each selector is one of the border-width
 * classes, so the browser finds the few elements that have one by their class and only then looks up
 * their ancestors; a rule on \`*\` or \`[class*=border]\` under every root made it look up the ancestors of
 * every element against some forty selectors, and a 100ms browser spec miss its budget. In the base
 * layer, so \`border-input\` and the like still win.
 */
@layer base {
${borders} {
		border-color: var(--color-border);
	}
}

/*
 * A Chopin control in a copy's slot (\`data-chopin-control\`) is Chopin's again: the variables above
 * return to Chopin's values for it, and the rules below leave it alone.
 */
[data-chopin-control] {
${lines(theirs)}
}

/*
 * Chopin's global button rules are unlayered and so beat a copy's utilities: a transition that is
 * only \`scale\`, a press that scales, and a focus outline beside the copy's own ring. A copy keeps
 * what it declares.
 */
${aimedAt("", TARGETS)} {
	transition: revert-layer;
}

${aimedAt("", PRESSABLE, ":active")} {
	scale: revert-layer;
}

:focus-visible:is(${roots.join(", ")})${OWN},
${copies(0)} :focus-visible${OWN} {
	outline: revert-layer;
	outline-offset: revert-layer;
}

/*
 * Where motion is reduced the endless motion of a copy (the pulse of a recording's dot, and the
 * shimmer of a label that says it is working, which assistant-ui's own \`motion-reduce\` utility does
 * not stop) holds still, as Chopin's own motion does. The subject is the class, a handful of roots
 * above it.
 */
@media (prefers-reduced-motion: reduce) {
	.animate-pulse:is(${roots.join(", ")}),
	.shimmer:is(${roots.join(", ")}),
	${copies(1)} .animate-pulse,
	${copies(1)} .shimmer {
		animation: none;
	}
}

/*
 * A small control keeps its look; an invisible target of the coarse size grows around it, so the
 * visible box is the same on touch. In the components layer so utilities such as \`absolute\` win.
 */
@layer components {
${aimedAt("\t:root[data-plan-coarse-pointer] ", TARGETS)} {
		position: relative;
	}

${aimedAt("\t:root[data-plan-coarse-pointer] ", TARGETS, "::after")} {
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
