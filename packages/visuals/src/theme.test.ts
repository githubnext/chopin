import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "../theme.css"), "utf8");
const NIGHT_START = SOURCE.indexOf('\n:root[data-theme="dark"] {');
/** The light theme's values, and the dark theme's, which replace some of them at night. */
const THEME = SOURCE.slice(0, NIGHT_START);
const NIGHT = SOURCE.slice(NIGHT_START, SOURCE.indexOf("\n}", NIGHT_START));

const SCALES = {
	ruby: [
		"oklch(0.99364 0.00344 354.69)",
		"oklch(0.98260 0.00865 8.54)",
		"oklch(0.95384 0.02210 7.18)",
		"oklch(0.92496 0.03933 8.14)",
		"oklch(0.89604 0.05620 7.27)",
		"oklch(0.85820 0.06638 8.00)",
		"oklch(0.81067 0.07992 7.15)",
		"oklch(0.74888 0.10209 6.50)",
		"oklch(0.611 0.171 13.15)",
		"oklch(0.55 0.182 13.52)",
		"oklch(0.457 0.19852 13.9)",
		"oklch(0.34105 0.10955 10.00)",
	],
	orange: [
		"oklch(0.99231 0.00252 48.72)",
		"oklch(0.97962 0.01577 73.68)",
		"oklch(0.95832 0.03712 79.11)",
		"oklch(0.91996 0.06510 74.37)",
		"oklch(0.88789 0.08751 71.31)",
		"oklch(0.85372 0.10682 66.02)",
		"oklch(0.80586 0.11233 59.96)",
		"oklch(0.74500 0.13223 54.68)",
		"oklch(0.716 0.146 45.02)",
		"oklch(0.633 0.158 43.46)",
		"oklch(0.558 0.158 42.74)",
		"oklch(0.34993 0.06851 40.83)",
	],
	lime: [
		"oklch(0.99246 0.00408 121.56)",
		"oklch(0.98166 0.00944 119.57)",
		"oklch(0.95878 0.04281 118.62)",
		"oklch(0.93191 0.06833 120.20)",
		"oklch(0.89733 0.08759 122.06)",
		"oklch(0.85315 0.09915 123.29)",
		"oklch(0.79482 0.11160 125.43)",
		"oklch(0.72504 0.13507 128.23)",
		"oklch(0.684 0.12 126.09)",
		"oklch(0.603 0.132 126.75)",
		"oklch(0.474 0.14 128.6)",
		"oklch(0.35370 0.05728 120.98)",
	],
} as const;

type Theme = "light" | "dark";

function declaredIn(source: string, name: string): string | undefined {
	let found = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(source);
	return found?.[1]?.trim().replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

/** A token as the theme draws it: at night, the dark block's value where it has one. */
function declared(name: string, theme: Theme = "light"): string | undefined {
	return (theme === "dark" ? declaredIn(NIGHT, name) : undefined) ?? declaredIn(THEME, name);
}

function scale(name: keyof typeof SCALES): [number, string][] {
	return [...THEME.matchAll(new RegExp(`\\n\\s*--color-${name}-(\\d+):\\s*([^;]+);`, "g"))]
		.map(match => [Number(match[1]), match[2]!.trim()] as [number, string]);
}

function resolved(name: string, theme: Theme = "light"): string | undefined {
	let value = declared(name, theme);
	let alias = value ? /^var\((--[\w-]+)\)$/.exec(value) : undefined;
	return alias ? resolved(alias[1]!, theme) : value;
}

function linearChannels(name: string, theme: Theme = "light"): [number, number, number] {
	let value = resolved(name, theme) ?? "";
	let oklch = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(value);
	if (!oklch) return [Number.NaN, Number.NaN, Number.NaN];
	let lightness = Number(oklch[1]);
	let chroma = Number(oklch[2]);
	let radians = (Number(oklch[3]) * Math.PI) / 180;
	let a = chroma * Math.cos(radians);
	let b = chroma * Math.sin(radians);
	let long = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	let medium = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	let short = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
		-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
		-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
	];
}

function contrast(foreground: string, background: string, theme: Theme = "light"): number {
	let luminance = (name: string) => {
		let [red, green, blue] = linearChannels(name, theme).map(channel => Math.max(0, channel)) as [
			number,
			number,
			number,
		];
		return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
	};
	let light = Math.max(luminance(foreground), luminance(background));
	let dark = Math.min(luminance(foreground), luminance(background));
	return (light + 0.05) / (dark + 0.05);
}

describe("semantic colour foundations", () => {
	it("defines exactly twelve ordered steps in each approved raw scale", () => {
		for (let name of Object.keys(SCALES) as (keyof typeof SCALES)[]) {
			expect(scale(name).map(([step]) => step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		}
	});

	it("keeps every approved raw value, including the tuned action and ink steps", () => {
		for (let [name, expected] of Object.entries(SCALES)) {
			expect(scale(name as keyof typeof SCALES).map(([, value]) => value)).toEqual([...expected]);
		}
	});

	it("maps each component-facing role to its approved scale step", () => {
		let expected = {
			"--color-neutral-surface": "var(--color-gray-100)",
			"--color-neutral-graphic": "var(--color-gray-450)",
			"--color-neutral-icon": "var(--color-gray-500)",
			"--color-neutral-text": "var(--color-gray-700)",
			"--color-success-surface": "var(--color-lime-3)",
			"--color-success-graphic": "var(--color-lime-8)",
			"--color-success-icon": "var(--color-lime-11)",
			"--color-success-text": "var(--color-lime-12)",
			"--color-warning-surface": "var(--color-orange-3)",
			"--color-warning-graphic": "var(--color-orange-8)",
			"--color-warning-icon": "var(--color-orange-11)",
			"--color-warning-text": "var(--color-orange-12)",
			"--color-danger-surface": "var(--color-ruby-3)",
			"--color-danger-graphic": "var(--color-ruby-9)",
			"--color-danger-icon": "var(--color-ruby-11)",
			"--color-danger-text": "var(--color-ruby-12)",
		};
		expect(Object.fromEntries(Object.keys(expected).map(name => [name, declared(name)]))).toEqual(
			expected,
		);
	});

	it("keeps every semantic text role at AA contrast on its surface", () => {
		for (let role of ["neutral", "success", "warning", "danger"]) {
			let ratio = contrast(`--color-${role}-text`, `--color-${role}-surface`);
			expect({ role, passes: ratio >= 4.5 }).toEqual({ role, passes: true });
		}
	});

	it("keeps the neutral graphic above 3:1 contrast on white tables", () => {
		expect(contrast("--color-neutral-graphic", "--color-page")).toBeGreaterThanOrEqual(3);
	});

	it("keeps recovery-action ink legible on hover and pressed danger surfaces", () => {
		for (let state of ["hover", "active"]) {
			expect(contrast("--color-danger-text", `--color-danger-surface-${state}`))
				.toBeGreaterThanOrEqual(4.5);
		}
	});

	it("does not remap the existing brand or legacy status roles", () => {
		let expected = {
			"--color-brand": "oklch(0.50006 0.08514 210.06)",
			"--color-brand-hover": "oklch(0.42914 0.07315 210.634)",
			"--color-brand-active": "oklch(0.37546 0.06382 210.435)",
			"--color-brand-wash": "oklch(0.925 0.02 210)",
			"--color-brand-ink": "oklch(0.43882 0.07476 210.193)",
			"--color-success": "oklch(0.51958 0.10966 145.072)",
			"--color-success-wash": "oklch(0.93 0.026 145)",
			"--color-success-ink": "oklch(0.44098 0.11068 144.754)",
			"--color-warning": "oklch(0.59898 0.12586 74.986)",
			"--color-warning-wash": "oklch(0.95 0.032 75)",
			"--color-warning-ink": "oklch(0.4409 0.0921 74.93)",
			"--color-destructive": "oklch(0.588 0.17178 24.175)",
			"--color-destructive-hover": "oklch(0.5532 0.16045 24.136)",
			"--color-destructive-active": "oklch(0.5172 0.1489 24.091)",
			"--color-destructive-wash":
				"color-mix(in srgb, var(--color-destructive) 20%, var(--color-page))",
			"--color-destructive-ink": "oklch(0.4941 0.19046 25.161)",
		};
		expect(Object.fromEntries(Object.keys(expected).map(name => [name, declared(name)]))).toEqual(
			expected,
		);
	});
});

describe("the dark theme", () => {
	let surfaces = ["page", "ground", "inset", "raised"];

	it("turns every raw step over: twelve per semantic scale and the thirteen grays", () => {
		for (let name of ["ruby", "orange", "lime", "plum"]) {
			let steps = [...NIGHT.matchAll(new RegExp(`\\n\\s*--color-${name}-(\\d+):`, "g"))];
			expect([name, steps.map(match => Number(match[1]))]).toEqual([
				name,
				[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
			]);
		}
		let grays = [...NIGHT.matchAll(/\n\s*--color-gray-(\d+):/g)].map(match => match[1]);
		let day = [...THEME.matchAll(/\n\s*--color-gray-(\d+):/g)].map(match => match[1]);
		expect(grays).toEqual(day);
	});

	it("lifts depth with light: the ground darkest, then the inset, the page and raised surfaces", () => {
		let order = ["ground", "inset", "page", "raised"].map(name =>
			contrast(`--color-${name}`, "--color-ground", "dark")
		);
		expect(order).toEqual(order.toSorted((a, b) => a - b));
		expect(new Set(order).size).toBe(4);
		expect(declared("--color-raised")).toBe("var(--color-page)");
	});

	it("keeps every ink role at AA on every surface, in the order light has them", () => {
		let inks = ["primary", "secondary", "tertiary", "quaternary"];
		for (let surface of surfaces) {
			for (let ink of inks) {
				let ratio = contrast(`--color-text-${ink}`, `--color-${surface}`, "dark");
				expect({ surface, ink, passes: ratio >= 4.5 }).toEqual({ surface, ink, passes: true });
			}
		}
		for (let theme of ["light", "dark"] as const) {
			let ratios = inks.map(ink => contrast(`--color-text-${ink}`, "--color-page", theme));
			expect([theme, ratios]).toEqual([theme, ratios.toSorted((a, b) => b - a)]);
		}
		expect(contrast("--color-text-tertiary", "--color-selected", "dark")).toBeGreaterThanOrEqual(
			4.5,
		);
	});

	it("keeps petrol legible as text on every surface, with the page's colour legible on it", () => {
		for (let role of ["brand", "brand-hover", "brand-active", "brand-ink"]) {
			for (let surface of [...surfaces, "selected", "brand-wash"]) {
				let ratio = contrast(`--color-${role}`, `--color-${surface}`, "dark");
				expect({ role, surface, passes: ratio >= 4.5 }).toEqual({ role, surface, passes: true });
			}
			let on = contrast("--color-page", `--color-${role}`, "dark");
			expect({ role, on: on >= 4.5 }).toEqual({ role, on: true });
		}
		// The focus ring is petrol in both themes, 3:1 or more on every ground.
		for (let surface of surfaces) {
			expect(contrast("--color-brand", `--color-${surface}`, "dark")).toBeGreaterThanOrEqual(3);
		}
	});

	it("keeps the destructive fills legible under the page's colour, each state further from it", () => {
		let states = ["destructive", "destructive-hover", "destructive-active"].map(role =>
			contrast("--color-page", `--color-${role}`, "dark")
		);
		for (let ratio of states) expect(ratio).toBeGreaterThanOrEqual(4.5);
		expect(states).toEqual(states.toSorted((a, b) => a - b));
		for (let surface of surfaces) {
			expect(contrast("--color-destructive-ink", `--color-${surface}`, "dark"))
				.toBeGreaterThanOrEqual(4.5);
		}
	});

	it("keeps every semantic quad's text at AA and its icon at 3:1 on its surface", () => {
		for (let role of ["neutral", "success", "warning", "danger", "merged"]) {
			let text = contrast(`--color-${role}-text`, `--color-${role}-surface`, "dark");
			let icon = contrast(`--color-${role}-icon`, `--color-${role}-surface`, "dark");
			expect({ role, text: text >= 4.5, icon: icon >= 3 }).toEqual({
				role,
				text: true,
				icon: true,
			});
		}
		for (let state of ["hover", "active"]) {
			expect(contrast("--color-danger-text", `--color-danger-surface-${state}`, "dark"))
				.toBeGreaterThanOrEqual(4.5);
		}
		for (let role of ["success", "warning"]) {
			for (let surface of [...surfaces, `${role}-wash`]) {
				let ratio = contrast(`--color-${role}-ink`, `--color-${surface}`, "dark");
				expect({ role, surface, passes: ratio >= 4.5 }).toEqual({ role, surface, passes: true });
			}
		}
	});

	it("keeps the edges people find controls by at 3:1", () => {
		// The hover is a light veil over its surface; the browser walk measures it where it lies.
		for (let surface of [...surfaces, "selected"]) {
			let boundary = contrast("--color-control-boundary", `--color-${surface}`, "dark");
			expect({ surface, passes: boundary >= 3 }).toEqual({ surface, passes: true });
		}
		expect(contrast("--color-neutral-graphic", "--color-page", "dark")).toBeGreaterThanOrEqual(3);
		expect(contrast("--color-tooltip-ink", "--color-tooltip", "dark")).toBeGreaterThanOrEqual(4.5);
	});

	it("keeps the image viewer the same dark in both themes", () => {
		for (let token of ["--color-viewer", "--color-viewer-muted", "--color-white"]) {
			expect([token, declaredIn(NIGHT, token)]).toEqual([token, undefined]);
		}
		expect(contrast("--color-viewer-muted", "--color-viewer")).toBeGreaterThanOrEqual(4.5);
	});
});
