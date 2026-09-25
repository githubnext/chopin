import type { Hue, Oklch, Palette, Token } from "@chopin/color";

export type FixtureHue = {
	name: string;
	swatches: { step: string; value: Oklch; source: string }[];
};

export const CHOPIN_LIGHT_HUES: FixtureHue[] = [
	{
		name: "ruby",
		swatches: [
			{ step: "1", value: { l: 0.99364, c: 0.00344, h: 354.69 }, source: "--color-ruby-1" },
			{ step: "2", value: { l: 0.98260, c: 0.00865, h: 8.54 }, source: "--color-ruby-2" },
			{ step: "3", value: { l: 0.95384, c: 0.02210, h: 7.18 }, source: "--color-ruby-3" },
			{ step: "4", value: { l: 0.92496, c: 0.03933, h: 8.14 }, source: "--color-ruby-4" },
			{ step: "5", value: { l: 0.89604, c: 0.05620, h: 7.27 }, source: "--color-ruby-5" },
			{ step: "6", value: { l: 0.85820, c: 0.06638, h: 8.00 }, source: "--color-ruby-6" },
			{ step: "7", value: { l: 0.81067, c: 0.07992, h: 7.15 }, source: "--color-ruby-7" },
			{ step: "8", value: { l: 0.74888, c: 0.10209, h: 6.50 }, source: "--color-ruby-8" },
			{ step: "9", value: { l: 0.611, c: 0.171, h: 13.15 }, source: "--color-ruby-9" },
			{ step: "10", value: { l: 0.55, c: 0.182, h: 13.52 }, source: "--color-ruby-10" },
			{ step: "11", value: { l: 0.457, c: 0.19852, h: 13.9 }, source: "--color-ruby-11" },
			{ step: "12", value: { l: 0.34105, c: 0.10955, h: 10.00 }, source: "--color-ruby-12" },
		],
	},
	{
		name: "orange",
		swatches: [
			{ step: "1", value: { l: 0.99231, c: 0.00252, h: 48.72 }, source: "--color-orange-1" },
			{ step: "2", value: { l: 0.97962, c: 0.01577, h: 73.68 }, source: "--color-orange-2" },
			{ step: "3", value: { l: 0.95832, c: 0.03712, h: 79.11 }, source: "--color-orange-3" },
			{ step: "4", value: { l: 0.91996, c: 0.06510, h: 74.37 }, source: "--color-orange-4" },
			{ step: "5", value: { l: 0.88789, c: 0.08751, h: 71.31 }, source: "--color-orange-5" },
			{ step: "6", value: { l: 0.85372, c: 0.10682, h: 66.02 }, source: "--color-orange-6" },
			{ step: "7", value: { l: 0.80586, c: 0.11233, h: 59.96 }, source: "--color-orange-7" },
			{ step: "8", value: { l: 0.74500, c: 0.13223, h: 54.68 }, source: "--color-orange-8" },
			{ step: "9", value: { l: 0.716, c: 0.146, h: 45.02 }, source: "--color-orange-9" },
			{ step: "10", value: { l: 0.633, c: 0.158, h: 43.46 }, source: "--color-orange-10" },
			{ step: "11", value: { l: 0.558, c: 0.158, h: 42.74 }, source: "--color-orange-11" },
			{ step: "12", value: { l: 0.34993, c: 0.06851, h: 40.83 }, source: "--color-orange-12" },
		],
	},
	{
		name: "lime",
		swatches: [
			{ step: "1", value: { l: 0.99246, c: 0.00408, h: 121.56 }, source: "--color-lime-1" },
			{ step: "2", value: { l: 0.98166, c: 0.00944, h: 119.57 }, source: "--color-lime-2" },
			{ step: "3", value: { l: 0.95878, c: 0.04281, h: 118.62 }, source: "--color-lime-3" },
			{ step: "4", value: { l: 0.93191, c: 0.06833, h: 120.20 }, source: "--color-lime-4" },
			{ step: "5", value: { l: 0.89733, c: 0.08759, h: 122.06 }, source: "--color-lime-5" },
			{ step: "6", value: { l: 0.85315, c: 0.09915, h: 123.29 }, source: "--color-lime-6" },
			{ step: "7", value: { l: 0.79482, c: 0.11160, h: 125.43 }, source: "--color-lime-7" },
			{ step: "8", value: { l: 0.72504, c: 0.13507, h: 128.23 }, source: "--color-lime-8" },
			{ step: "9", value: { l: 0.684, c: 0.12, h: 126.09 }, source: "--color-lime-9" },
			{ step: "10", value: { l: 0.603, c: 0.132, h: 126.75 }, source: "--color-lime-10" },
			{ step: "11", value: { l: 0.474, c: 0.14, h: 128.6 }, source: "--color-lime-11" },
			{ step: "12", value: { l: 0.35370, c: 0.05728, h: 120.98 }, source: "--color-lime-12" },
		],
	},
	{
		name: "gray",
		swatches: [
			{ step: "50", value: { l: 0.99051, c: 0.00263, h: 95 }, source: "--color-gray-50" },
			{ step: "100", value: { l: 0.97857, c: 0.00264, h: 95 }, source: "--color-gray-100" },
			{ step: "150", value: { l: 0.96623, c: 0.0039, h: 95 }, source: "--color-gray-150" },
			{ step: "200", value: { l: 0.94216, c: 0.00393, h: 95 }, source: "--color-gray-200" },
			{ step: "300", value: { l: 0.89108, c: 0.00552, h: 95 }, source: "--color-gray-300" },
			{ step: "400", value: { l: 0.74029, c: 0.00856, h: 95 }, source: "--color-gray-400" },
			{ step: "450", value: { l: 0.66810, c: 0.01050, h: 95 }, source: "--color-gray-450" },
			{ step: "500", value: { l: 0.56514, c: 0.0123, h: 95 }, source: "--color-gray-500" },
			{ step: "600", value: { l: 0.48124, c: 0.01278, h: 95 }, source: "--color-gray-600" },
			{ step: "700", value: { l: 0.39036, c: 0.01026, h: 95 }, source: "--color-gray-700" },
			{ step: "750", value: { l: 0.32036, c: 0.00877, h: 95 }, source: "--color-gray-750" },
			{ step: "800", value: { l: 0.25993, c: 0.00745, h: 95 }, source: "--color-gray-800" },
			{ step: "900", value: { l: 0.15908, c: 0.00637, h: 95 }, source: "--color-gray-900" },
		],
	},
];

export const CHOPIN_TOKENS: Token[] = [
	["surface", "ground", "gray", "150"],
	["surface", "hover", "gray", "100"],
	["surface", "inset", "gray", "100"],
	["surface", "selected", "gray", "200"],
	["text", "text-primary", "gray", "900"],
	["text", "text-secondary", "gray", "700"],
	["text", "text-tertiary", "gray", "600"],
	["text", "text-quaternary", "gray", "500"],
	["text", "icon", "gray", "500"],
	["neutral", "neutral-surface", "gray", "100"],
	["neutral", "neutral-graphic", "gray", "450"],
	["neutral", "neutral-icon", "gray", "500"],
	["neutral", "neutral-text", "gray", "700"],
	["success", "success-surface", "lime", "3"],
	["success", "success-graphic", "lime", "8"],
	["success", "success-icon", "lime", "11"],
	["success", "success-text", "lime", "12"],
	["warning", "warning-surface", "orange", "3"],
	["warning", "warning-graphic", "orange", "8"],
	["warning", "warning-icon", "orange", "11"],
	["warning", "warning-text", "orange", "12"],
	["danger", "danger-surface", "ruby", "3"],
	["danger", "danger-graphic", "ruby", "9"],
	["danger", "danger-icon", "ruby", "11"],
	["danger", "danger-text", "ruby", "12"],
	["control", "control-boundary", "gray", "500"],
].map(([group, name, hue, step]) => ({
	group,
	name,
	ref: { hue, step },
	source: `--color-${name}`,
}));

let lightGray = CHOPIN_LIGHT_HUES.find(hue => hue.name === "gray")!;
export const CHOPIN_DARK_HUES: Hue[] = [{
	name: "gray",
	swatches: lightGray.swatches.map((swatch, index, all) => ({
		step: swatch.step,
		value: all[all.length - 1 - index].value,
	})),
}];

export const CHOPIN_PALETTE: Palette = {
	themes: { light: CHOPIN_LIGHT_HUES, dark: CHOPIN_DARK_HUES },
	tokens: CHOPIN_TOKENS,
};
