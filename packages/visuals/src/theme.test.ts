import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const THEME = readFileSync(join(import.meta.dir, "../theme.css"), "utf8");

const SCALES = {
	ruby: [
		"#fffcfd",
		"#fff7f8",
		"#feeaed",
		"#ffdce1",
		"#ffced6",
		"#f8bfc8",
		"#efacb8",
		"#e592a3",
		"oklch(0.611 0.171 13.15)",
		"oklch(0.55 0.182 13.52)",
		"oklch(0.457 0.19852 13.9)",
		"#64172b",
	],
	orange: [
		"#fefcfb",
		"#fff7ed",
		"#ffefd6",
		"#ffdfb5",
		"#ffd19a",
		"#ffc182",
		"#f5ae73",
		"#ec9455",
		"oklch(0.716 0.146 45.02)",
		"oklch(0.633 0.158 43.46)",
		"oklch(0.558 0.158 42.74)",
		"#582d1d",
	],
	lime: [
		"#fcfdfa",
		"#f8faf3",
		"#eef6d6",
		"#e2f0bd",
		"#d3e7a6",
		"#c2da91",
		"#abc978",
		"#8db654",
		"oklch(0.684 0.12 126.09)",
		"oklch(0.603 0.132 126.75)",
		"oklch(0.474 0.14 128.6)",
		"#37401c",
	],
} as const;

function declared(name: string): string | undefined {
	let found = new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(THEME);
	return found?.[1]?.trim().replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

function scale(name: keyof typeof SCALES): [number, string][] {
	return [...THEME.matchAll(new RegExp(`\\n\\s*--color-${name}-(\\d+):\\s*([^;]+);`, "g"))]
		.map(match => [Number(match[1]), match[2]!.trim()] as [number, string]);
}

function resolved(name: string): string | undefined {
	let value = declared(name);
	let alias = value ? /^var\((--[\w-]+)\)$/.exec(value) : undefined;
	return alias ? resolved(alias[1]!) : value;
}

function linearChannels(name: string): [number, number, number] {
	let value = resolved(name) ?? "";
	let hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
	if (hex) {
		return hex.slice(1).map(channel => {
			let encoded = Number.parseInt(channel!, 16) / 255;
			return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
		}) as [number, number, number];
	}

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

function contrast(foreground: string, background: string): number {
	let luminance = (name: string) => {
		let [red, green, blue] = linearChannels(name);
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
			expect(scale(name as keyof typeof SCALES).map(([, value]) => value)).toEqual(expected);
		}
	});

	it("maps each component-facing role to its approved scale step", () => {
		let expected = {
			"--color-neutral-surface": "var(--color-gray-100)",
			"--color-neutral-graphic": "var(--color-gray-300)",
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
			"--color-destructive": "oklch(0.60513 0.17178 24.175)",
			"--color-destructive-hover": "oklch(0.56972 0.16045 24.136)",
			"--color-destructive-active": "oklch(0.53376 0.1489 24.091)",
			"--color-destructive-wash":
				"color-mix(in srgb, var(--color-destructive) 20%, var(--color-page))",
			"--color-destructive-ink": "oklch(0.4941 0.19046 25.161)",
		};
		expect(Object.fromEntries(Object.keys(expected).map(name => [name, declared(name)]))).toEqual(
			expected,
		);
	});
});
