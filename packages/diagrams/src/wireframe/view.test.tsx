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
