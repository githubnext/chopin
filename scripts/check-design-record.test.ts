import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { designRecordProblems } from "./design-contract/record";

let read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");
let theme = read("packages/visuals/theme.css");
let markdown = read("apps/web/DESIGN.md");
let json = read("apps/web/.impeccable/design.json");
let context = {
	web: read("apps/web/src/theme.css"),
	editor: read("packages/editor/src/styles.css"),
};
let check = (
	options: { theme?: string; markdown?: string; json?: string; context?: typeof context } = {},
) =>
	designRecordProblems(
		options.theme ?? theme,
		options.markdown ?? markdown,
		options.json ?? json,
		options.context ?? context,
	);
let editJSON = (edit: (value: any) => void) => {
	let value = JSON.parse(json);
	edit(value);
	return JSON.stringify(value);
};

describe("structured design record", () => {
	test("the actual recorded subset agrees with its implementation owners", () => {
		expect(check()).toEqual([]);
	});

	test("resolves CSS and documented aliases without changing the expected value", () => {
		expect(check({
			markdown: markdown.replace(
				'petrol: "oklch(0.50006 0.08514 210.06)"',
				'petrol: "var(--color-brand)"',
			)
				.replace('page: "oklch(1 0 0)"', 'page: "{components.document.backgroundColor}"')
				.replace('backgroundColor: "{colors.page}"', 'backgroundColor: "var(--color-page)"')
				.replace(/backgroundColor: "\{colors.page\}"/g, 'backgroundColor: "var(--color-page)"'),
			json: editJSON(value => {
				value.extensions.colorMeta.ground.canonical = "var(--color-ground)";
			}),
		})).toEqual([]);
	});

	test("a conflicting colour fails even if both documents agree", () => {
		let wrong = "oklch(0.4 0.08 210)";
		let result = check({
			markdown: markdown.replace("oklch(0.50006 0.08514 210.06)", wrong),
			json: editJSON(value => {
				value.extensions.colorMeta.petrol.canonical = wrong;
			}),
		});
		expect(result.some(value => value.startsWith("DESIGN.md.colors.petrol:"))).toBe(true);
		expect(
			result.some(value => value.startsWith("design.json.extensions.colorMeta.petrol.canonical:")),
		).toBe(true);
	});

	test("checks fluid roles, full font stacks, leading, radius, and spacing", () => {
		for (
			let [before, after, diagnostic] of [
				['fontSize: "var(--text-2xl)"', 'fontSize: "32px"', ".fontSize:"],
				["system-ui, -apple-system", "system-ui, Helvetica", ".fontFamily:"],
				["lineHeight: 1.6", "lineHeight: 1.5", ".lineHeight:"],
				['md: "0.375rem"', 'md: "0.4rem"', ".rounded.md:"],
				['eight: "2rem"', 'eight: "3rem"', ".spacing.eight:"],
			]
		) {
			expect(
				check({ markdown: markdown.replace(before, after) }).some(value =>
					value.includes(diagnostic)
				),
			).toBe(true);
		}
	});

	test("checks the small metadata role in both design records", () => {
		expect(
			check({
				markdown: markdown.replace('fontSize: "var(--text-2xs)"', 'fontSize: "var(--text-xs)"'),
			})[0],
		).toContain("DESIGN.md.typography.small-metadata.fontSize:");
		expect(
			check({
				json: editJSON(value => {
					delete value.extensions.typographyMeta["small-metadata"];
				}),
			})[0],
		).toContain("design.json.extensions.typographyMeta.small-metadata: missing mapped field");
	});

	test("validates document heading fonts separately from prose and interface fonts", () => {
		let result = check({
			theme: theme.replace(
				'--font-document-heading: "Lora", Georgia, serif',
				'--font-document-heading: "Lora", "Times New Roman", serif',
			),
		});
		expect(result.map(value => value.split(":")[0])).toEqual([
			"DESIGN.md.typography.document-title.fontFamily",
			"DESIGN.md.typography.section-heading.fontFamily",
			"DESIGN.md.typography.subheading.fontFamily",
		]);
		expect(
			check({
				markdown: markdown.replace(
					/document-body:\n    fontFamily: [^\n]+/,
					'document-body:\n    fontFamily: "var(--font-document-heading)"',
				),
			}).map(value => value.split(":")[0]),
		).toEqual([
			"DESIGN.md.typography.document-body.fontFamily",
		]);
	});

	test("checks sidecar shadows and motion against canonical tokens", () => {
		expect(
			check({
				json: editJSON(value => {
					value.extensions.shadows[0].value = "none";
				}),
			})[0],
		)
			.toContain("shadows.resting:");
		expect(
			check({
				json: editJSON(value => {
					value.extensions.motion[0].value = "200ms";
				}),
			})[0],
		)
			.toContain("motion.fast:");
	});

	test("checks contextual declarations without turning them into global tokens", () => {
		expect(
			check({
				context: { ...context, web: context.web.replace("rgb(0 0 0 / 9%)", "rgb(0 0 0 / 8%)") },
			})[0],
		)
			.toContain("colors.chat-divider:");
		expect(
			check({
				context: {
					...context,
					editor: context.editor.replace("line-height: 1.6;", "line-height: 1.7;"),
				},
			})[0],
		)
			.toContain("document-body.lineHeight:");
		expect(check({ context: { ...context, web: "" } })[0]).toContain(
			"expected exactly one contextual declaration",
		);
	});

	test("unknown, missing, and duplicate mapped entries fail", () => {
		expect(check({ markdown: markdown.replace("  petrol:", "  unknown:") })[0]).toContain(
			"missing mapped field",
		);
		expect(check({ markdown: markdown.replace("colors:\n", 'colors:\n  unknown: "red"\n') })[0])
			.toContain("unknown mapped field");
		expect(
			check({
				json: editJSON(value => {
					value.extensions.motion.pop();
				}),
			})[0],
		).toContain("missing mapped field");
		expect(
			check({
				json: editJSON(value => {
					value.extensions.motion.push(value.extensions.motion[0]);
				}),
			})[0],
		)
			.toContain("duplicate mapped field");
	});

	test("unknown aliases and CSS or document alias cycles fail", () => {
		expect(check({ markdown: markdown.replace('"{colors.petrol}"', '"{colors.missing}"') })[0])
			.toContain("unknown alias");
		expect(
			check({
				theme: theme.replace(
					"--color-brand: oklch(0.50006 0.08514 210.06)",
					"--color-brand: var(--missing)",
				),
			})[0],
		)
			.toContain("unknown token");
		expect(
			check({
				theme: theme.replace(
					"--color-brand: oklch(0.50006 0.08514 210.06)",
					"--color-brand: var(--color-brand-hover)",
				)
					.replace(
						"--color-brand-hover: oklch(0.42914 0.07315 210.634)",
						"--color-brand-hover: var(--color-brand)",
					),
			})[0],
		)
			.toContain("alias cycle");
		expect(
			check({
				markdown: markdown.replace(
					'petrol: "oklch(0.50006 0.08514 210.06)"',
					'petrol: "{colors.petrol}"',
				),
			})[0],
		)
			.toContain("alias cycle");
	});

	test("a later Tailwind reset cannot leave a documented token apparently defined", () => {
		expect(check({ theme: theme + "\n@theme { --color-*: initial; }" })[0]).toContain(
			"unknown token",
		);
	});

	test("malformed YAML, JSON, CSS, and wrong shapes fail closed", () => {
		for (
			let options of [
				{ markdown: "No frontmatter" },
				{ markdown: "---\ncolors: [\n---\n" },
				{ markdown: markdown.replace("colors:\n", "colors: null\ncolors:\n") },
				{ json: "{" },
				{ json: "[]" },
				{ theme: "@theme {" },
				{
					json: editJSON(value => {
						value.extensions.shadows = {};
					}),
				},
			]
		) expect(check(options).length).toBeGreaterThan(0);
	});

	test("timestamps and prose do not serve as evidence of consistency", () => {
		expect(check({
			json: editJSON(value => {
				value.generatedAt = "1900-01-01";
				value.narrative.overview = "Human judgment.";
			}),
		}))
			.toEqual([]);
	});
});
