import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EvidencePopover, EvidenceSummary } from "./evidence-popover";

import type { EvidenceRow } from "./evidence";

const ROWS: EvidenceRow[] = [
	{
		optionId: "github",
		label: "GitHub Apps",
		origin: "chat",
		supporters: ["mina", "jules"],
		opposers: ["lee"],
		items: [{
			id: "r1",
			kind: "reason",
			text: "People already have GitHub accounts.",
			sources: [{
				messageId: "m1",
				author: { kind: "member", handle: "mina" },
				quote: "People already have GitHub accounts.",
				start: 0,
				end: 36,
				role: "reason",
			}],
		}],
	},
	{
		optionId: "sso",
		label: "Enterprise SSO",
		origin: "planner",
		supporters: [],
		opposers: [],
		items: [],
		rationale: "Enterprise customers expect SAML.",
	},
];

test("each row shows its label, stances, sourced evidence and Planner rationale", () => {
	let markup = renderToStaticMarkup(
		createElement(EvidencePopover, { rows: ROWS, onSource: () => {} }),
	);

	expect(markup).toContain('aria-label="Evidence"');
	expect(markup).toContain("GitHub Apps");
	expect(markup).toContain("Supported by mina, jules");
	expect(markup).toContain("Opposed by lee");
	expect(markup).toContain("ring-2 ring-warning");
	expect(markup).toContain("People already have GitHub accounts.");
	expect(markup).toContain('aria-label="Show “People already have GitHub accounts.” in chat"');
	expect(markup).toContain("Planner suggested");
	expect(markup).toContain("Why Chopin suggested this: Enterprise customers expect SAML.");
	expect(markup).not.toMatch(/<(input|select|textarea)\b/);
});

test("shows at most eight avatar images while naming every participant accessibly", () => {
	let handles = ["mina", "jules", "lee", "ana", "bo", "cy", "di", "eve", "flo", "gus"];
	let opponents = ["nora", "otto", "paz", "quinn", "ravi", "suki", "tali", "uma", "viktor"];
	let row: EvidenceRow = {
		optionId: "many",
		label: "A crowded option",
		origin: "chat",
		supporters: handles,
		opposers: opponents,
		items: [],
	};
	let markup = renderToStaticMarkup(
		createElement(EvidencePopover, { rows: [row], onSource: () => {} }),
	);

	expect(markup.match(/<img\b/g)).toHaveLength(16);
	expect(markup).toContain(`Supported by ${handles.join(", ")}`);
	expect(markup).toContain(`Opposed by ${opponents.join(", ")}`);
	expect(markup).toContain(">+2</span>");
	expect(markup).toContain(">+1</span>");
});

test("omits source controls without sources and hides non-Planner rationale", () => {
	let row: EvidenceRow = {
		optionId: "human",
		label: "Human option",
		origin: "human",
		supporters: [],
		opposers: [],
		items: [{
			id: "c1",
			kind: "constraint",
			text: "Must work offline.",
			sources: [],
		}],
		rationale: "Only a Planner rationale belongs here.",
	};
	let markup = renderToStaticMarkup(
		createElement(EvidencePopover, { rows: [row], onSource: () => {} }),
	);

	expect(markup).toContain("Constraint");
	expect(markup).toContain("Must work offline.");
	expect(markup).not.toContain("Show “Must work offline.” in chat");
	expect(markup).not.toContain("Why Chopin suggested this:");
});

test("shows an exact attributed quote for a sourced Planner option", () => {
	let row: EvidenceRow = {
		optionId: "jev",
		label: "Invite Jev",
		origin: "planner",
		supporters: [],
		opposers: [],
		items: [],
		rationale: "Jev can review the plan.",
		source: {
			messageId: "m-jevi",
			author: { kind: "member", handle: "mina" },
			quote: "Jev needs access to the release plan.",
			start: 4,
			end: 41,
			role: "option",
		},
	};
	let markup = renderToStaticMarkup(
		createElement(EvidencePopover, { rows: [row], onSource: () => {} }),
	);

	expect(markup).toContain("Invite Jev");
	expect(markup).toContain("@mina");
	expect(markup).toContain("<q class=");
	expect(markup).toContain("Jev needs access to the release plan.");
	expect(markup).toContain('aria-label="Show “Jev needs access to the release plan.” in chat"');
});

test("does not present a rationale-only Planner option as a chat quote", () => {
	let row: EvidenceRow = {
		optionId: "jev",
		label: "Invite Jev",
		origin: "planner",
		supporters: [],
		opposers: [],
		items: [],
		rationale: "Repository permissions require it.",
	};
	let markup = renderToStaticMarkup(
		createElement(EvidencePopover, { rows: [row], onSource: () => {} }),
	);

	expect(markup).toContain("Why Chopin suggested this: Repository permissions require it.");
	expect(markup).not.toContain("<q class=");
	expect(markup).not.toContain("in chat");
});

test("groups decision-wide evidence and marks objections", () => {
	let row: EvidenceRow = {
		label: "Should we ship a small pilot?",
		origin: "chat",
		supporters: [],
		opposers: [],
		items: [
			{ id: "c1", kind: "constraint", text: "Keep it keyboard accessible.", sources: [] },
			{
				id: "o1",
				kind: "objection",
				text: "A pilot excludes keyboard users.",
				sources: [],
				by: "ana",
			},
		],
	};
	let markup = renderToStaticMarkup(
		createElement(EvidencePopover, { rows: [row], onSource: () => {} }),
	);

	expect(markup).toContain("Applies to all options");
	expect(markup).not.toContain("Should we ship a small pilot?");
	expect(markup).toContain('text-warning-ink">Objection</span>');
	expect(markup).toContain("A pilot excludes keyboard users.");
	expect(markup).toContain(">@ana</span>");
});

test("summarises evidence counts with objections in warning ink", () => {
	let summary = (counts: Parameters<typeof EvidenceSummary>[0]["counts"]) =>
		renderToStaticMarkup(createElement(EvidenceSummary, { counts }));

	expect(summary({ reasons: 1, constraints: 2, objections: 1 })).toBe(
		'<span>1 reason</span><span aria-hidden="true">·</span><span>2 constraints</span>'
			+ '<span aria-hidden="true">·</span><span class="text-warning-ink">1 objection</span>',
	);
	expect(summary({ reasons: 0, constraints: 0, objections: 0 })).toBe("Evidence");
});
