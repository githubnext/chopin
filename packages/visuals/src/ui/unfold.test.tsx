import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { UnfoldPanel, UnfoldSection, UnfoldToggle, useUnfold } from "@chopin/visuals/unfold";

const CSS = readFileSync(join(import.meta.dir, "unfold.css"), "utf8");

function Harness({ defaultOpen, speed }: { defaultOpen?: boolean; speed?: "card" | "accordion" }) {
	let unfold = useUnfold(defaultOpen, speed);
	return (
		<>
			<UnfoldToggle aria-label="Preview report" className="host" unfold={unfold}>
				Preview
			</UnfoldToggle>
			<UnfoldPanel className="panel" unfold={unfold}>
				<a href="https://example.com/source">Source</a>
			</UnfoldPanel>
		</>
	);
}

function tagWithId(markup: string, id: string): string {
	let escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return markup.match(new RegExp(`<div[^>]*id="${escaped}"[^>]*>`))?.[0] ?? "";
}

test("a closed unfold names its panel and keeps the content mounted but inert", () => {
	let markup = renderToStaticMarkup(<Harness />);
	let id = markup.match(/aria-controls="([^"]+)"/)?.[1];

	expect(id).toBeTruthy();
	expect(markup).toContain('aria-expanded="false"');
	expect(markup).toContain('type="button"');
	expect(markup).toContain('aria-label="Preview report"');
	expect(markup).toMatch(/<button[^>]*class="cv-unfold-toggle host"/);
	let panel = tagWithId(markup, id!);
	expect(panel).toContain('data-slot="unfold"');
	expect(panel).toContain('class="cv-unfold panel"');
	expect(panel).toContain('inert=""');
	expect(panel).toContain('aria-hidden="true"');
	expect(panel).not.toContain("data-open");
	expect(markup).toContain('<div class="cv-unfold-clip"><div class="cv-unfold-content">');
	expect(markup).toContain('href="https://example.com/source"');
});

test("an open unfold exposes its panel", () => {
	let markup = renderToStaticMarkup(<Harness defaultOpen />);
	let id = markup.match(/aria-controls="([^"]+)"/)?.[1];
	let panel = tagWithId(markup, id!);

	expect(markup).toContain('aria-expanded="true"');
	expect(panel).toContain('data-open=""');
	expect(panel).not.toContain("inert");
	expect(panel).not.toContain("aria-hidden");
});

test("the toggle carries one decorative chevron after its label", () => {
	let markup = renderToStaticMarkup(<Harness />);

	let chevron = markup.match(/Preview(<svg[^>]*>)/)?.[1] ?? "";
	expect(chevron).toContain('class="cv-unfold-chevron"');
	expect(chevron).toContain('aria-hidden="true"');
});

test("a section pairs a labelled toggle with its panel", () => {
	let markup = renderToStaticMarkup(
		<UnfoldSection label="Report">
			<p>Body</p>
		</UnfoldSection>,
	);

	expect(markup).toContain('data-slot="unfold-section"');
	expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Report<svg/);
	expect(markup).toContain('<div class="cv-unfold-section-body"><p>Body</p></div>');
});

test("toggle and panel carry the same speed; accordion is the default", () => {
	let plain = renderToStaticMarkup(<Harness />);
	let card = renderToStaticMarkup(<Harness speed="card" />);

	expect(plain.match(/data-unfold-speed="accordion"/g)).toHaveLength(2);
	expect(card.match(/data-unfold-speed="card"/g)).toHaveLength(2);
});

test("speeds map to tokens: accordion 250ms, card previews 600ms", () => {
	expect(CSS).toMatch(
		/\.cv-unfold,\s*\.cv-unfold-toggle\s*{\s*--cv-unfold-duration:\s*var\(--acc-expand\);/,
	);
	expect(CSS).toMatch(
		/\[data-unfold-speed="card"\]\s*{\s*--cv-unfold-duration:\s*var\(--duration-linger\);/,
	);
});

test("the fold uses jig row D motion and reverses through CSS transitions", () => {
	expect(CSS).toMatch(
		/\.cv-unfold\s*{[^}]*grid-template-rows:\s*0fr;[^}]*transition:\s*grid-template-rows var\(--cv-unfold-duration\) var\(--ease-out\)/s,
	);
	expect(CSS).toMatch(/\.cv-unfold\[data-open\]\s*{[^}]*grid-template-rows:\s*1fr/s);
	expect(CSS).toMatch(/\.cv-unfold-content\s*{[^}]*transform:\s*rotateX\(-40deg\)/s);
	expect(CSS).toMatch(/\.cv-unfold-content\s*{[^}]*visibility 0s var\(--cv-unfold-duration\)/s);
});

test("reduced motion snaps the fold and keeps a short crossfade", () => {
	let reduced = CSS.match(/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*)}\s*$/)?.[1] ?? "";

	expect(reduced).toMatch(/\.cv-unfold\s*{\s*transition:\s*none;/);
	expect(reduced).toMatch(
		/\.cv-unfold-content\s*{[^}]*transform:\s*none;[^}]*opacity var\(--duration-base\)/s,
	);
	expect(reduced).toMatch(/\.cv-unfold-chevron\s*{\s*transition:\s*none;/);
});
