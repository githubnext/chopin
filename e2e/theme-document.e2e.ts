/**
 * A document by day and by night.
 *
 * Code coloured where it is edited, a patch's drawn preview, a Mermaid diagram and a deck of open
 * decisions are drawn in the page's theme and meet WCAG 2.2 AA in both: every word against what is
 * behind it, read by the design walk (`design/contrast.ts`, which crosses the preview's shadow root
 * and reads each painted range of code), and a diagram's labels, which the walk leaves to their
 * drawing, against the shape each sits on. A change of theme with the document open recolours it
 * where it stands: the same editor, blocks and preview, the reader's selection and focus kept, and
 * nothing eased across. A diagram bakes the theme into its drawing, so it is drawn again, as the
 * reader comes within a screen of it. What can be decided without a browser (the palettes, the
 * Mermaid variables, which theme the page is in) is `code-theme.test.ts`, `mermaid-theme.test.ts`
 * and `theme.test.ts`.
 */

import { storedQuestion } from "../apps/server/src/testing/plan";
import { ulid } from "../packages/dialect/src/ulid";
import { contrastWalk } from "./design/contrast";
import { content, expect, test } from "./room";

import type { SeedState } from "../apps/server/src/testing/plan";
import type { Measured } from "./design/contrast";
import type { Locator, Page } from "@playwright/test";

const WIDE = { viewport: { width: 1440, height: 1000 } };

const CODE = [
	[
		"ts",
		'export async function open(room: string): Promise<Plan> {\n\t// The latest known-good state.\n\tlet epoch = await rotate(room, 3);\n\treturn { room, epoch, title: "Plan" };\n}',
	],
	[
		"python",
		'def settle(rows: list[str]) -> int:\n    """Count what is left."""\n    return len([row for row in rows if row])  # none empty',
	],
	["rust", 'fn main() {\n    let count: u32 = 42;\n    println!("{}", count);\n}'],
	["json", '{ "name": "chopin", "private": true, "version": 3 }'],
	["bash", 'bun run e2e --grep "theme" && echo done'],
] as const;

const PATCH = `\`\`\`diff
--- a/apps/server/src/plan/room.ts
+++ b/apps/server/src/plan/room.ts
@@ -1,4 +1,5 @@
 export function open(room: string): Plan {
-	return { doc, epoch: 1 };
+	let epoch = rotate(room);
+	return { doc, epoch };
 }
\`\`\``;

/** A subgraph's box is the one colour only the drawing carries, so it says which theme drew it. */
const DIAGRAM =
	"```mermaid\nflowchart LR\n  subgraph Client\n    A[Browser] -->|edits| B(Editor)\n  end\n  B --> C[(Store)]\n```";

const PROMPTS = ["Where should room state live?", "How should we deploy?"];

/** Open decisions with their records, next to each other so they stack as a deck. */
function decisions(): { blocks: string; state: SeedState } {
	let questions: unknown[] = [];
	let openQuestions: unknown[] = [];
	let blocks = PROMPTS.map((prompt, index) => {
		let widget = ulid();
		let question = ulid();
		let options = [ulid(), ulid()].map((id, at) => ({
			id,
			label: at === 0 ? `Option ${index + 1}` : "Something else",
			description: "",
		}));
		let definition = {
			questions: [{
				id: question,
				header: `Decision ${index + 1}`,
				question: prompt,
				multiple: false,
				options,
			}],
		};
		questions.push({
			id: widget,
			definition,
			status: "open",
			origin: "planner",
			history: [],
			optionOrigins: {},
			editors: [],
		});
		openQuestions.push({
			definition,
			id: widget,
			model: storedQuestion(definition),
			revision: 0,
			widget,
		});
		return `<Questionnaire id="${widget}">
<Question id="${question}" header="Decision ${index + 1}" prompt="${prompt}" multiple="false">
${options.map(option => `<Option id="${option.id}" label="${option.label}" />`).join("\n")}
</Question>
</Questionnaire>`;
	});
	return { blocks: blocks.join("\n\n"), state: { revision: 1, questions, openQuestions } };
}

function documentSource(): { source: string; state: SeedState } {
	let { blocks, state } = decisions();
	let code = CODE.map(([language, text]) => `\`\`\`${language}\n${text}\n\`\`\``).join("\n\n");
	return {
		source:
			`# Night and day\n\nThe patch below moves the epoch into the room.\n\n${code}\n\n${PATCH}\n\n${DIAGRAM}\n\n${blocks}\n`,
		state,
	};
}

function failures(rows: Measured[]): string[] {
	return rows
		.filter(row => !row.exempt && row.fg !== "none" && row.ratio < row.threshold)
		.map(row =>
			`${row.role} "${row.text}": ${row.fg} on ${row.bg} is ${row.ratio}:1, under ${row.threshold}:1 (${row.path})`
		);
}

/** How many of the document's code blocks the highlighter has painted. */
function paintedBlocks(page: Page): Promise<number> {
	return content(page).evaluate(root =>
		[...root.querySelectorAll(".planCode")].filter(block =>
			[...CSS.highlights].some(([name, highlight]) =>
				name.startsWith("plan-code-")
				&& [...highlight].some(range => block.contains(range.startContainer))
			)
		).length
	);
}

/** Everything drawn: code painted, the patch's preview, the diagram and the deck. */
async function drawn(page: Page) {
	let diagram = content(page).locator('[data-plan-language="mermaid"]');
	await diagram.scrollIntoViewIfNeeded();
	await expect(diagram.locator(".plan-diagram svg g.cluster")).toBeVisible({ timeout: 15_000 });
	await expect.poll(() => paintedBlocks(page), { timeout: 15_000 }).toBe(CODE.length);
	await expect(
		content(page).locator('[data-plan-language="diff"] diffs-container [data-line]').first(),
	)
		.toBeVisible();
	await expect(page.locator('[data-document-view="plan"] [data-deck]')).toBeVisible();
}

/**
 * A Mermaid drawing's subgraph box, as dark (under 0.2) or light as the theme that drew it: its
 * relative luminance, read through a canvas so every colour space the page writes comes out alike.
 */
function clusterLuminance(diagram: Locator): Promise<number> {
	return diagram.locator("svg g.cluster rect").first().evaluate(rect => {
		let context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		context.fillStyle = getComputedStyle(rect).fill;
		context.fillRect(0, 0, 1, 1);
		let [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].map(value => {
			let v = value / 255;
			return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
	});
}

/** Each label of a Mermaid drawing against the shape it sits on, by WCAG's ratio. */
function diagramLabels(diagram: Locator): Promise<{ text: string; ratio: number }[]> {
	return diagram.locator("svg").first().evaluate(svg => {
		let context = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
		let luminance = (colour: string) => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = colour;
			context.fillRect(0, 0, 1, 1);
			let [r, g, b] = [...context.getImageData(0, 0, 1, 1).data].map(value => {
				let v = value / 255;
				return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
			});
			return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
		};
		let ratio = (a: string, b: string) => {
			let [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
			return Math.round(((high! + 0.05) / (low! + 0.05)) * 100) / 100;
		};
		let pairs: { text: string; ratio: number }[] = [];
		for (let node of svg.querySelectorAll("g.node")) {
			let label = node.querySelector<HTMLElement>(".nodeLabel");
			let shape = node.querySelector(".label-container");
			if (!label || !shape) continue;
			pairs.push({
				text: label.textContent ?? "",
				ratio: ratio(getComputedStyle(label).color, getComputedStyle(shape).fill),
			});
		}
		for (let edge of svg.querySelectorAll("g.edgeLabel")) {
			let label = edge.querySelector<HTMLElement>("p, span");
			let box = edge.querySelector<HTMLElement>(".labelBkg");
			if (!label?.textContent || !box) continue;
			pairs.push({
				text: label.textContent,
				ratio: ratio(getComputedStyle(label).color, getComputedStyle(box).backgroundColor),
			});
		}
		for (let cluster of svg.querySelectorAll("g.cluster")) {
			let label = cluster.querySelector<HTMLElement>(".nodeLabel, span");
			let box = cluster.querySelector("rect");
			if (!label || !box) continue;
			pairs.push({
				text: label.textContent ?? "",
				ratio: ratio(getComputedStyle(label).color, getComputedStyle(box).fill),
			});
		}
		return pairs;
	});
}

/** The marked elements still on the page, and how many were marked. */
function marks() {
	let elements = [
		document.querySelector(".plan-content[contenteditable]")!,
		...document.querySelectorAll(".plan-content .planCode"),
		...document.querySelectorAll(".plan-content diffs-container"),
		...document.querySelectorAll(
			'.plan-content [data-plan-language="mermaid"] [data-plan-preview]',
		),
		...document.querySelectorAll('[data-document-view="plan"] [data-deck]'),
	];
	let { marked } = window as unknown as { marked: number };
	return {
		marked,
		kept: elements.filter(element => (element as unknown as { kept?: boolean }).kept).length,
	};
}

/** Opens the document in `mode`, the system's scheme, which a person's default (System) follows. */
async function open(
	join: (handle: string, options?: object) => Promise<Page>,
	mode: "light" | "dark",
) {
	let page = await join("ana", { ...WIDE, colorScheme: mode });
	await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
	return page;
}

for (let mode of ["light", "dark"] as const) {
	test(`code, a patch, a diagram and a decision deck meet AA contrast, in ${mode}`, async ({ join, seed }) => {
		test.setTimeout(120_000);
		let { source, state } = documentSource();
		await seed(source, state);
		let page = await open(join, mode);
		await drawn(page);

		let rows = await contrastWalk(page, '[data-document-view="plan"]', { focus: false });
		// Every block's code is measured, range by range, and the patch inside its shadow root.
		expect(
			rows.filter(row => row.role === "text" && /rotate|settle|println|chopin|grep/.test(row.text))
				.length,
		)
			.toBeGreaterThan(4);
		expect(rows.some(row => row.path.includes("diffs-container") || /epoch/.test(row.text))).toBe(
			true,
		);
		expect(rows.filter(row => PROMPTS.some(prompt => row.text.includes(prompt))).length)
			.toBeGreaterThan(0);
		expect(failures(rows)).toEqual([]);

		let labels = await diagramLabels(content(page).locator('[data-plan-language="mermaid"]'));
		expect(labels.map(label => label.text)).toEqual(
			expect.arrayContaining(["Browser", "Editor", "Store", "edits", "Client"]),
		);
		expect(labels.filter(label => label.ratio < 4.5)).toEqual([]);
	});
}

test("switching the theme recolours an open document where it stands, keeping the reader's selection", async ({ join, seed }) => {
	test.setTimeout(120_000);
	let { source, state } = documentSource();
	await seed(source, state);
	let page = await open(join, "light");
	await drawn(page);
	let diagram = content(page).locator('[data-plan-language="mermaid"]');
	let patch = content(page).locator('[data-plan-language="diff"]');

	// Everything that must not be made again is marked, so a remount would lose the mark.
	let marked = await page.evaluate(() => {
		let elements = [
			document.querySelector(".plan-content[contenteditable]")!,
			...document.querySelectorAll(".plan-content .planCode"),
			...document.querySelectorAll(".plan-content diffs-container"),
			...document.querySelectorAll(
				'.plan-content [data-plan-language="mermaid"] [data-plan-preview]',
			),
			...document.querySelectorAll('[data-document-view="plan"] [data-deck]'),
		];
		for (let element of elements) (element as unknown as { kept: boolean }).kept = true;
		(window as unknown as { marked: number }).marked = elements.length;
		return elements.length;
	});
	expect(marked).toBe(CODE.length + 6);

	// The reader has a word selected in the prose, with the caret's editor focused.
	await content(page).focus();
	await content(page).evaluate(root => {
		let walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			let at = node.textContent!.indexOf("epoch");
			if (at < 0) continue;
			let range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + "epoch".length);
			getSelection()!.removeAllRanges();
			getSelection()!.addRange(range);
			return;
		}
	});
	await expect.poll(() => page.evaluate(() => getSelection()!.toString())).toBe("epoch");

	let colours = () =>
		page.evaluate(() => {
			let root = document.querySelector(".plan-content")!;
			let host = root.querySelector('[data-plan-language="diff"] diffs-container')!;
			let token = [...host.shadowRoot!.querySelectorAll("span")].find(span =>
				span.textContent === "export"
			)!;
			let code = root.querySelector(".planCode [data-plan-source]")!;
			return {
				keyword: getComputedStyle(code, "::highlight(plan-code-keyword)").color,
				patchWord: getComputedStyle(token).color,
				patchGround: getComputedStyle(host.shadowRoot!.querySelector("pre")!).backgroundColor,
				page: getComputedStyle(root).getPropertyValue("--color-page").trim(),
			};
		});
	let day = await colours();
	let dayCluster = await clusterLuminance(diagram);
	expect(dayCluster).toBeGreaterThan(0.6);

	for (let mode of ["dark", "light"] as const) {
		await page.emulateMedia({ colorScheme: mode });
		await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
		// Nothing eases across: no transition runs anywhere in the document as its colours change.
		let easing = await page.evaluate(() =>
			document.getAnimations().filter(animation =>
				animation instanceof CSSTransition
				&& /color|background|fill|stroke|border|outline|shadow/.test(animation.transitionProperty)
				&& document.querySelector('[data-document-view="plan"]')!.contains(
					(animation.effect as KeyframeEffect).target as Element,
				)
			).map(animation => (animation as CSSTransition).transitionProperty)
		);
		expect(easing).toEqual([]);

		// The drawing is made again in the new theme, in the same preview.
		if (mode === "dark") await expect.poll(() => clusterLuminance(diagram)).toBeLessThan(0.2);
		else await expect.poll(() => clusterLuminance(diagram)).toBeGreaterThan(0.6);
		let now = await colours();
		if (mode === "dark") {
			expect(now.keyword).not.toBe(day.keyword);
			expect(now.patchWord).not.toBe(day.patchWord);
			expect(now.patchGround).not.toBe(day.patchGround);
			expect(now.page).not.toBe(day.page);
		} else {
			expect(now).toEqual(day);
		}

		// Recoloured where it stands: the same editor, blocks, preview and deck, and the selection.
		expect(await page.evaluate(marks)).toEqual(
			await page.evaluate(() => {
				let { marked } = window as unknown as { marked: number };
				return { marked, kept: marked };
			}),
		);
		expect(await page.evaluate(() => getSelection()!.toString())).toBe("epoch");
		expect(await content(page).evaluate(root => root.contains(document.activeElement))).toBe(true);
		await expect(patch.locator("diffs-container [data-line]").first()).toBeVisible();
	}
});

/** Several screens of prose, so a diagram after it is well beyond a screen of the first view. */
const PROSE = "A paragraph of the specification, long enough to take a line of its own.\n\n".repeat(
	150,
);

test("a change of theme draws again only the diagrams near the reader, and the rest on the way to them", async ({ join, seed }) => {
	test.setTimeout(120_000);
	await seed(`# Specification\n\n${DIAGRAM}\n\n${PROSE}${DIAGRAM.replace("Client", "Server")}\n`);
	let page = await open(join, "light");
	let [near, far] = [0, 1].map(index =>
		content(page).locator('[data-plan-language="mermaid"]').nth(index)
	);
	await expect(near.locator(".plan-diagram svg g.cluster")).toBeVisible({ timeout: 15_000 });
	// The far diagram is drawn once the reader reaches it, then the reader goes back to the top.
	await far.scrollIntoViewIfNeeded();
	await expect(far.locator(".plan-diagram svg g.cluster")).toBeVisible({ timeout: 15_000 });
	await far.locator(".plan-diagram svg").evaluate(svg => {
		(svg as unknown as { day: boolean }).day = true;
	});
	await near.scrollIntoViewIfNeeded();
	expect(await clusterLuminance(far)).toBeGreaterThan(0.6);

	await page.emulateMedia({ colorScheme: "dark" });
	await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	await expect.poll(() => clusterLuminance(near)).toBeLessThan(0.2);
	// Two frames on, the far drawing is still the day's: nothing far from the reader was drawn.
	await page.evaluate(() =>
		new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	expect(
		await far.locator(".plan-diagram svg").evaluate(svg =>
			(svg as unknown as { day?: boolean }).day
		),
	)
		.toBe(true);

	await far.scrollIntoViewIfNeeded();
	await expect.poll(() => clusterLuminance(far)).toBeLessThan(0.2);
	expect(
		await far.locator(".plan-diagram svg").evaluate(svg =>
			(svg as unknown as { day?: boolean }).day
		),
	)
		.toBeUndefined();
});
