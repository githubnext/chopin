import { describe, expect, it } from "bun:test";

import { contentEditableClassName$, corePlugin, readOnly$ } from "@mdxeditor/editor";
import { Realm } from "@mdxeditor/gurx";
import { toMarkdown } from "mdast-util-to-markdown";

import { NODES } from "./dialect";
import { parse } from "./parse";
import { plugins } from "./registry";
import { extensions } from "./serialize";

import type { Nodes } from "mdast";

/**
 * Stand in for `<MDXEditor>`, which installs a core plugin built from its own
 * props and then applies the plugins it was given — re-running every plugin's
 * `update` on each render.
 */
function mount(list: ReturnType<typeof plugins>): Realm {
	let realm = new Realm();
	let host = corePlugin({
		contentEditableClassName: "plan-content",
		readOnly: true,
		initialMarkdown: "",
		spellCheck: true,
		toMarkdownOptions: {},
		autoFocus: false,
		placeholder: "",
		iconComponentFor: () => null as never,
		suppressHtmlProcessing: true,
		translation: (_key: string, fallback: string) => fallback,
		trim: true,
		onChange: () => {},
		onBlur: () => {},
		onError: () => {},
		additionalLexicalNodes: [],
		lexicalEditorNamespace: "Test",
	});

	host.init?.(realm);
	for (let plugin of list) plugin.init?.(realm);

	// A render pass.
	host.update?.(realm);
	for (let plugin of list) plugin.update?.(realm);

	return realm;
}

describe("the dialect plugin set", () => {
	it("leaves the host's editor settings alone", () => {
		let realm = mount(plugins({ core: false }));

		// A second core plugin re-publishes these from its own params, so
		// carrying one here would quietly overwrite what the host asked for:
		// the content class the styling hangs off, and — worse — read-only,
		// which is what stops a plan being typed into mid-turn.
		expect(realm.getValue(contentEditableClassName$)).toBe("plan-content");
		expect(realm.getValue(readOnly$)).toBe(true);
	});

	it("supplies its own core when there is no host", () => {
		// The VM builds the same schema headlessly, where nothing else provides
		// the base visitors and nodes.
		let realm = new Realm();
		for (let plugin of plugins()) plugin.init?.(realm);

		expect(realm.getValue(contentEditableClassName$)).toBe("");
	});
});

/** Every node type the dialect accepts, in one document. */
const SAMPLE = `# Title

Text with **bold**, _italic_, ~~struck~~, \`code\`, a [link](https://example.com),
an ![image](https://example.com/x.png) and $a + b$ inline math.\\
A hard break precedes this line.

---

> Quoted.

- one
- [ ] a task

1. first

\`\`\`js title="a.js"
let x = 1;
\`\`\`

$$
E = mc^2
$$

| a | b |
| - | - |
| 1 | 2 |

A reference[^01K0N4V4E7Y6P4MJ5WD8XZF3B2] and <Var name="x" /> inline.

[^01K0N4V4E7Y6P4MJ5WD8XZF3B2]: The note.

<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note">

Inside.

</Callout>
`;

function types(node: Nodes, seen = new Set<string>()): Set<string> {
	seen.add(node.type);
	for (let child of "children" in node ? node.children : []) types(child as Nodes, seen);
	return seen;
}

/**
 * The markdown extensions are what turn MDAST back into text, and `markdown
 * Plugin` hands this same list to the editor's realm — because MDXEditor
 * serialises the whole document on every update, and a node type it cannot
 * write throws rather than degrading.
 *
 * That listener is registered when the root editor is built, ahead of every
 * composer child, so Lexical abandons the rest of the loop and everything
 * behind it is skipped, collaboration included. One unhandled node and the plan
 * accepts edits while sending none of them, silently, until it is reloaded.
 *
 * So this list has to cover the whole dialect, not just what `exportPlan`
 * happens to meet.
 */
describe("markdown extensions", () => {
	it("write every node type the dialect accepts", () => {
		expect(() => toMarkdown(parse(SAMPLE), { extensions: extensions() })).not.toThrow();
	});

	/** Keeps the sample honest: a new node type has to be covered above. */
	it("is exercised against the whole dialect", () => {
		let covered = types(parse(SAMPLE));
		let missing = NODES.filter(type => !covered.has(type));

		expect(missing).toEqual([]);
	});
});
