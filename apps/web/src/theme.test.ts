/**
 * Whether a highlight can be seen.
 *
 * Nothing else can check this. There is no DOM in the test runtime and no
 * `CSS.highlights` to register against, so a mark painted in page-white looks
 * exactly like a mark that failed to paint — which is how an invisible palette
 * shipped twice, once because a percentage was calibrated against a token that
 * was already pale, and once because the visible part of the old rule was an
 * outline rather than the wash it was copied from.
 *
 * So this does the arithmetic instead: resolve each tone against the theme it
 * names, composite it over the page, and insist the result is far enough from
 * the background to be a mark at all. It also checks the colour recorded beside
 * each declaration, because that comment is what the next person will calibrate
 * against and a stale one is worse than none.
 *
 * It lives here rather than beside the stylesheet because the app owns the
 * palette; the editor only names tokens, and a package must not read an app.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Oklch = { l: number; c: number; h: number };

const THEME = readFileSync(join(import.meta.dir, "theme.css"), "utf8");
const NAVIGATION = readFileSync(join(import.meta.dir, "navigation.css"), "utf8");
const RESEARCH = readFileSync(join(import.meta.dir, "research-workspace.css"), "utf8");
const STYLES = readFileSync(
	join(import.meta.dir, "../../../packages/editor/src/styles.css"),
	"utf8",
);
const FEEDBACK = readFileSync(
	join(import.meta.dir, "../../../packages/editor/src/feedback.css"),
	"utf8",
);

/** A colour token, resolving semantic aliases onto the primitive palette. */
function token(name: string): Oklch {
	let declaration = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(THEME)?.[1]?.trim();
	if (!declaration) throw new Error(`no --color-${name} in the theme`);
	let alias = /^var\(--color-([\w-]+)\)$/.exec(declaration);
	if (alias) return token(alias[1]!);
	let found = /^oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/.exec(declaration);
	if (!found) throw new Error(`no --color-${name} in the theme`);
	return { l: Number(found[1]), c: Number(found[2]), h: Number(found[3]) };
}

function hex({ c, h, l }: Oklch): string {
	let radians = (h * Math.PI) / 180;
	let a = c * Math.cos(radians);
	let b = c * Math.sin(radians);

	let long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	let medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	let short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

	let channels = [
		4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
		-1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
		-0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
	];

	return `#${
		channels
			.map(value => {
				let encoded = value <= 0.0031308
					? 12.92 * value
					: 1.055 * Math.pow(Math.max(value, 0), 1 / 2.4) - 0.055;
				return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
					.toString(16)
					.padStart(2, "0");
			})
			.join("")
	}`;
}

type Mark = { name: string; token: string; recorded: string };

/** Every highlight the stylesheet declares, with the colour written beside it. */
function marks(): Mark[] {
	let pattern = /\/\* (#[0-9a-f]{6}) \*\/\s*\n\s*background-color: var\(--color-([\w-]+)\)/g;
	let named = /::highlight\((plan-[a-z-]+)\)/g;

	let names = [...STYLES.matchAll(named)].map(match => match[1]!);
	let found = [...STYLES.matchAll(pattern)].map((match, index) => ({
		name: names[index] ?? `#${index}`,
		recorded: match[1]!,
		token: match[2]!,
	}));

	if (found.length === 0) throw new Error("no highlight declarations found");
	return found;
}

/**
 * How far a mark has to be from the page to be one.
 *
 * The invisible tone that prompted this rendered `#f9fbff`, a lightness of
 * 0.979 against a page of 1.0. Anything that close is not a highlight, whatever
 * the stylesheet says it is.
 */
const PERCEPTIBLE = 0.04;

describe("marking prose", () => {
	let page = token("page");

	it("declares every highlight against a token the theme has", () => {
		for (let mark of marks()) expect(() => token(mark.token)).not.toThrow();
	});

	it("paints each one far enough from the page to be seen", () => {
		for (let mark of marks()) {
			let painted = token(mark.token);
			let distance = page.l - painted.l;

			// Asserted as an object so a failure names the mark and what it
			// renders as, rather than reporting a bare number nobody can place.
			expect({ mark: mark.name, renders: hex(painted), visible: distance > PERCEPTIBLE })
				.toEqual({ mark: mark.name, renders: hex(painted), visible: true });
		}
	});

	/** The recorded colour is what the next person will calibrate against. */
	it("records beside each one the colour it actually renders", () => {
		for (let mark of marks()) {
			expect({ mark: mark.name, hex: mark.recorded }).toEqual({
				mark: mark.name,
				hex: hex(token(mark.token)),
			});
		}
	});
});

describe("sidebar navigation", () => {
	it("uses primary text for the selected document", () => {
		expect(NAVIGATION).toMatch(
			/\.project-sidebar-document-current\s*{[^}]*color:\s*var\(--color-text-primary\)/s,
		);
	});

	it("keeps project rows on the compact spacing scale", () => {
		expect(NAVIGATION).toMatch(/\.project-sidebar-project-row\s*{[^}]*gap:\s*10px/s);
	});
});

describe("motion contracts", () => {
	it("uses semantic tokens for app popovers", () => {
		expect(THEME).toMatch(
			/\.motion-popover\s*{[^}]*var\(--dropdown-open-dur\)[^}]*var\(--dropdown-ease\)/s,
		);
	});

	it("settles app popovers under reduced motion", () => {
		expect(THEME).toMatch(
			/@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?\.motion-popover[\s\S]*?transition:\s*none;[\s\S]*?}/,
		);
	});

	it("uses the movement curve for the bounded sidebar track and child", () => {
		expect(THEME).toMatch(/--motion-move:\s*cubic-bezier\([^)]+\);/);
		expect(NAVIGATION).toMatch(
			/\.motion-sidebar\s*{[^}]*var\(--sidebar-open-dur\)[^}]*var\(--motion-move\)/s,
		);
		expect(NAVIGATION).toMatch(
			/\.motion-sidebar\s+\.project-sidebar\s*{[^}]*var\(--sidebar-open-dur\)[^}]*var\(--motion-move\)/s,
		);
	});

	it("settles the sidebar track and child under reduced motion", () => {
		expect(NAVIGATION).toMatch(
			/@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?\.motion-sidebar[\s\S]*?\.motion-sidebar \.project-sidebar[\s\S]*?transition:\s*none;[\s\S]*?}/,
		);
	});

	it("uses semantic dropdown timing for comment previews", () => {
		expect(STYLES).toMatch(
			/\.motion-comment-preview\s*{[^}]*var\(--dropdown-open-dur\)[^}]*var\(--dropdown-ease\)/s,
		);
		expect(STYLES).toMatch(
			/\.motion-comment-preview\.is-closing\s*{[^}]*var\(--dropdown-close-dur\)/s,
		);
		expect(STYLES).toMatch(
			/@starting-style\s*{[^}]*\.motion-comment-preview\.is-open\s*{[^}]*opacity:\s*0/s,
		);
	});

	it("settles comment previews under reduced motion", () => {
		expect(STYLES).toMatch(
			/@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?\.motion-comment-preview[\s\S]*?transition:\s*none;[\s\S]*?}/,
		);
	});

	it("uses the page timing, distance, and smooth curve for content swaps", () => {
		expect(THEME).toMatch(
			/\.motion-content-swap\s*{[^}]*var\(--page-slide-distance\)[^}]*var\(--page-slide-dur\)[^}]*var\(--motion-smooth-out\)/s,
		);
	});

	it("releases the transformed containing block after content swaps settle", () => {
		expect(THEME).toMatch(
			/\.motion-content-swap\.is-open\s*{[^}]*transform:\s*none;[^}]*will-change:\s*auto;/s,
		);
	});

	it("settles content swaps under reduced motion", () => {
		expect(THEME).toMatch(
			/@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?\.motion-content-swap[\s\S]*?transition:\s*none;[\s\S]*?}/,
		);
	});
});

describe("disclosure motion", () => {
	it("uses the accordion timing and movement curve for bounded collapse", () => {
		expect(THEME).toMatch(
			/\.motion-collapse\s*{[^}]*var\(--acc-expand\)[^}]*var\(--motion-move\)/s,
		);
	});

	it("uses the collapse timing when closing", () => {
		expect(THEME).toMatch(/\.motion-collapse\.is-closing\s*{[^}]*var\(--acc-collapse\)/s);
	});

	it("settles disclosure motion under reduced motion", () => {
		let reduced = THEME.match(
			/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*?)\n}/,
		)?.[1];
		expect(reduced).toContain(".motion-collapse,");
		expect(reduced).toContain(".motion-collapse-content {");
		expect(reduced).toMatch(/transition:\s*none;/);
	});
});

describe("feedback motion", () => {
	it("gates picker option colour feedback on pointer modality", () => {
		expect(THEME).toMatch(
			/:root\[data-motion-input="pointer"\]\s+\.motion-picker-option\s*{[^}]*background-color var\(--duration-fast\) var\(--ease-out\)/s,
		);
		expect(THEME).toMatch(
			/@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?:root\[data-motion-input="pointer"\]\s+\.motion-picker-option\s*{[^}]*transition:\s*none;/,
		);
	});

	it("uses CSS-native starting styles for one-shot pointer feedback", () => {
		for (
			let [kind, duration] of [
				["icon", "icon-swap-dur"],
				["count", "badge-pop-dur"],
				["alert", "toast-open"],
			]
		) {
			expect(THEME).toMatch(
				new RegExp(
					`:root\\[data-motion-input="pointer"\\]\\s+\\.motion-feedback\\[data-motion-feedback="${kind}"\\]\\s*{[^}]*transition-duration: var\\(--${duration}\\)[^}]*transition-timing-function: var\\(--motion-smooth-out\\)`,
					"s",
				),
			);
		}
		expect(THEME).toContain("@starting-style");
		expect(THEME).not.toContain("@keyframes feedback-");
	});

	it("uses the short control transition for Conversation hover glyphs", () => {
		expect(THEME).toMatch(
			/:root\[data-motion-input="pointer"\] \.conversation-toggle-icon\s*{[^}]*opacity var\(--duration-fast\) var\(--ease-out\)/s,
		);
	});

	it("leaves feedback opacity to the component", () => {
		for (let kind of ["icon", "count", "alert"]) {
			let settled = new RegExp(
				`\\.motion-feedback\\[data-motion-feedback="${kind}"\\]\\s*{([^}]*)}`,
			).exec(THEME)?.[1];
			expect(settled).not.toMatch(/opacity:/);
		}
	});

	it("keeps one-shot feedback below 300ms", () => {
		for (let token of ["icon-swap-dur", "badge-pop-dur", "toast-open"]) {
			let value = new RegExp(`--${token}:\\s*(\\d+)ms;`).exec(THEME)?.[1];
			expect({ token, duration: Number(value), short: Number(value) < 300 }).toEqual({
				token,
				duration: Number(value),
				short: true,
			});
		}
	});

	it("keeps icon and count deformation subtle", () => {
		let startingStyle = THEME.slice(THEME.indexOf("@starting-style"));
		for (
			let [kind, origin] of [
				["icon", "scale(0.96)"],
				["count", "translateY(2px) scale(0.96)"],
			]
		) {
			let body = new RegExp(
				`\\.motion-feedback\\[data-motion-feedback="${kind}"\\]\\s*{([\\s\\S]*?)\\n\\s*}`,
			).exec(startingStyle)?.[1];
			let scale = Number(/scale\(([\d.]+)\)/.exec(body ?? "")?.[1]);
			expect({ kind, origin, scale, subtle: scale >= 0.95 }).toEqual({
				kind,
				origin,
				scale,
				subtle: true,
			});
		}
	});

	it("settles feedback under reduced motion", () => {
		let reduced = THEME.match(
			/@media \(prefers-reduced-motion: reduce\)\s*{([\s\S]*?)\n}/,
		)?.[1];
		expect(reduced).toMatch(
			/:root\[data-motion-input="pointer"\]\s+\.motion-feedback\[data-motion-feedback\]\s*{/,
		);
		expect(reduced).toMatch(/transition-duration:\s*0s;/);
	});
});

describe("editor feedback motion", () => {
	it("uses host semantic timing and easing only for pointer-owned feedback", () => {
		for (
			let [kind, duration] of [
				["icon", "icon-swap-dur"],
				["count", "badge-pop-dur"],
				["alert", "toast-open"],
			]
		) {
			expect(FEEDBACK).toMatch(
				new RegExp(
					`:root\\[data-motion-input="pointer"\\]\\s+\\.editor-motion-feedback\\[data-motion-feedback="${kind}"\\][^{}]*{[^}]*transition-duration: var\\(--${duration}\\)[^}]*transition-timing-function: var\\(--motion-smooth-out\\)`,
					"s",
				),
			);
		}
		for (let [kind, duration] of [["icon", "icon-swap-dur"], ["alert", "toast-open"]]) {
			expect(FEEDBACK).toMatch(
				new RegExp(
					`\\.editor-motion-feedback\\[data-motion-feedback="${kind}"\\]\\[data-motion-owned="pointer"\\][^{}]*{[^}]*transition-duration: var\\(--${duration}\\)`,
					"s",
				),
			);
		}
		expect(FEEDBACK).not.toMatch(
			/(?:^|})\s*\.editor-motion-feedback\[data-motion-feedback="(?:icon|count|alert)"\]\s*{[^}]*transition-duration/s,
		);
	});

	it("starts editor icon, count, and alert feedback from their semantic origins", () => {
		let starting = FEEDBACK.slice(FEEDBACK.indexOf("@starting-style"));
		for (
			let [kind, origin] of [
				["icon", "scale(0.96)"],
				["count", "translateY(2px) scale(0.96)"],
				["alert", "translateY(4px)"],
			]
		) {
			expect(starting).toMatch(
				new RegExp(
					`\\.editor-motion-feedback\\[data-motion-feedback="${kind}"\\]\\s*{[^}]*opacity: 0;[^}]*transform: ${
						origin.replace(/[().]/g, "\\$&")
					}`,
					"s",
				),
			);
		}
	});

	it("settles pointer-owned editor feedback under reduced motion", () => {
		expect(FEEDBACK).toMatch(
			/@media \(prefers-reduced-motion: reduce\)\s*{[^}]*:root\[data-motion-input="pointer"\]\s+\.editor-motion-feedback\[data-motion-feedback\][^{}]*\.editor-motion-feedback\[data-motion-feedback\]\[data-motion-owned="pointer"\]\s*{[^}]*transition-duration:\s*0s;/s,
		);
	});
});

describe("research route alerts", () => {
	it("keeps stable spacing between the route failure heading and actions", () => {
		expect(RESEARCH).toMatch(
			/\.research-route-alert\s*{[^}]*margin:\s*8px 0 20px;/s,
		);
	});
});
