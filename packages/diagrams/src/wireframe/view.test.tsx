import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { parseWireframe } from "./parse";
import { WIREFRAME_KINDS } from "./schema";
import { Wireframe } from "./view";

const EVERY_KIND = `panel "Settings" #panel
  header "Repository"
    badge "beta" tone=info
  row flow
    card "Step"
      title "Parse"
      text "Bounded" muted
    stack
      card selected
        text "Render" strong
  row
    nav vertical active=1
      - General
      - Members
    stack
      tabs active=2
        - Profile
        - Access
      input "Name" value="chopin"
      list ordered
        - One
      image "Preview" ratio=square
      disclosure "More" open
        text "Hidden"
      divider
      button "Save" primary
      button "Delete" danger
      box shaded
        fill "Chart"
        lines n=3
        icon
      grid cols=2
        box repeat=2
  note "Two columns on wide screens" -> #panel`;

function markup(source: string): string {
	let result = parseWireframe(source);
	if (!result.ok) throw new Error(JSON.stringify(result.problems));
	return renderToStaticMarkup(<Wireframe wireframe={result.wireframe} focusable />);
}

test("the sample uses every kind", () => {
	let html = markup(EVERY_KIND);
	for (let kind of Object.keys(WIREFRAME_KINDS)) {
		if (kind === "note") continue;
		expect(html).toContain(`data-wf="${kind}"`);
	}
});

test("draws inert, with no real controls and no markup from the source", () => {
	let html = markup(
		`panel "<img src=x onerror=alert(1)>"\n  button "Go" primary\n  input "Name"`,
	);
	expect(html).toMatch(/<div class="wf-stage" inert="">/);
	expect(html).not.toMatch(/<(button|input|select|textarea|a)[\s>]/);
	expect(html).not.toContain("<img");
	expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
});

test("is a labelled region with an outline for assistive technology", () => {
	let html = markup(EVERY_KIND);
	expect(html).toMatch(/^<div role="region" aria-label="Settings wireframe"[^>]*tabindex="0"/);
	expect(html).toContain('<div class="wf-alt"><ul><li>Panel “Settings”');
	expect(html).toContain("<li>Button “Save”, primary</li>");
	expect(html).toContain('<ol aria-label="Notes"><li>Two columns on wide screens (on Panel');
});

test("numbers a note's target and lists the note", () => {
	let html = markup(`row\n  button "Save" #save\n  note "Saves all" -> #save`);
	expect(html).toContain('data-marked=""');
	expect(html).toContain('<span class="wf-mark"><span class="wf-mark-chip">1</span></span>');
	expect(html).toContain('<span class="wf-note-text">Saves all</span>');
});

test("joins a flow's parts with arrows between them, not around them", () => {
	let html = markup(`row flow\n  card "A"\n  card "B"\n  card "C"`);
	expect(html.match(/class="wf-arrow"/g)).toHaveLength(2);
});

test("the text alternative includes every tab as well as the selected tab", () => {
	let html = markup(`tabs active=2\n  - Profile\n  - Access`);
	expect(html).toContain(
		'<div class="wf-alt"><ul><li>Tabs, “Access” selected<ul><li>Profile</li><li>Access</li></ul>',
	);
});

test("flow connectors skip notes that live in the callout rail", () => {
	let html = markup(
		`row flow\n  note "Before" -> #a\n  card "A" #a\n  note "Between" -> #a\n  card "B"\n  note "After" -> #a`,
	);
	expect(html.match(/class="wf-arrow"/g)).toHaveLength(1);
});

test("a note marks a divider target as well as other parts", () => {
	let html = markup(`panel\n  divider #split\nnote "Separates sections" -> #split`);
	expect(html).toContain('<div data-wf="divider" data-marked=""><span class="wf-mark">');
});

test("repeat draws that many copies, and the outline lists the part once", () => {
	let html = markup(`grid cols=3\n  card repeat=3\n    lines n=2`);
	expect(html.match(/data-wf="card"/g)).toHaveLength(3);
	expect(html.match(/data-wf="lines"/g)).toHaveLength(3);
	expect(html.match(/<li>Card, repeated 3 times/g)).toHaveLength(1);
});

test("a note marks only the first copy of a repeated part", () => {
	let html = markup(`row\n  card repeat=3 #item\nnote "Each one" -> #item`);
	expect(html.match(/data-marked=""/g)).toHaveLength(1);
});

test("an unlabelled button is a placeholder bar", () => {
	let html = markup(`row\n  button\n  button "Go"`);
	expect(html).toContain('<span data-wf="button"><i class="wf-bar"></i></span>');
	expect(html).toContain("Go");
});

test("a nav with n draws that many placeholder items", () => {
	let html = markup(`nav vertical n=4 active=2`);
	expect(html.match(/<i class="wf-bar">/g)).toHaveLength(4);
	expect(html.match(/data-selected=""/g)).toHaveLength(1);
});

test("sizes and shares reach the DOM as data and a custom property", () => {
	let html = markup(`row flush h=lg\n  stack w=5\n  box shaded width=sm`);
	expect(html).toContain('data-h="lg"');
	expect(html).toContain('data-flush=""');
	expect(html).toContain('data-w="5"');
	expect(html).toContain("--w:5");
	expect(html).toContain('data-shaded=""');
	expect(html).toContain('data-width="sm"');
});
