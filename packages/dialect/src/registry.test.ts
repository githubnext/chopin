import { describe, expect, it } from "bun:test";

import { contentEditableClassName$, corePlugin, readOnly$ } from "@mdxeditor/editor";
import { Realm } from "@mdxeditor/gurx";
import { createHeadlessEditor } from "@lexical/headless";
import { createYjsBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical } from "@lexical/yjs";
import { $getRoot } from "lexical";
import * as Y from "yjs";
import { toMarkdown } from "mdast-util-to-markdown";

import { exportPlan, importPlan } from "./convert";
import { NODES } from "./dialect";
import { parse } from "./parse";
import { plugins, registry } from "./registry";
import { extensions } from "./serialize";
import { validate } from "./validate";

import type { Nodes } from "mdast";
import type { Provider } from "@lexical/yjs";

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

A reference[^01K0N4V4E7Y6P4MJ5WD8XZF3B2] and <Underline>x</Underline> inline.

[^01K0N4V4E7Y6P4MJ5WD8XZF3B2]: The note.

<Callout id="01K0N4W3B7P27CBAEC7A8C8WEA" type="note">

Inside.

</Callout>

<Tabs id="01K0N4TR8K7JGM4R1J7PW4R8YJ">
<Tab id="01K0N4V4E7Y6P4MJ5WD8XZF3B2" label="One">

Tab body.

</Tab>
</Tabs>

<Columns id="01K0N4W3B7P27CBAEC7A8C8WEB">
<Column id="01K0N4W3B7P27CBAEC7A8C8WEC">

Left side.

</Column>
<Column id="01K0N4W3B7P27CBAEC7A8C8WED">

Right side.

</Column>
</Columns>

<Research id="8f4d193b-2018-4977-b404-0092bb911676" />

<Experiment id="01K0N4W3B7P27CBAEC7A8C8WEH" experiment="investigation-one" view="table" />

<Questionnaire id="01K0N4W3B7P27CBAEC7A8C8WEE">
<Question id="01K0N4W3B7P27CBAEC7A8C8WEF" header="Choice" prompt="Choose one" multiple="false">
<Option id="01K0N4W3B7P27CBAEC7A8C8WEG" label="Yes" />
<Answer value="Yes" />
</Question>
</Questionnaire>

<Decision id="01K0N4X2M5R8T3VQ7YB6ZC4DEF" quote="Cached for 60 seconds." by="ana" at="2026-07-28T10:14:00Z">
  <Note by="ana" text="Too long; the data changes every 10s." />
</Decision>
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
	it("imports and exports all registered nodes in the headless editor", () => {
		let reg = registry();
		let errors: Error[] = [];
		let editor = createHeadlessEditor({ nodes: reg.nodes, onError: error => errors.push(error) });
		importPlan(editor, SAMPLE, { registry: reg });
		let output = exportPlan(editor, { registry: reg });
		expect(output).toContain("<Columns");
		expect(output).toContain("<Questionnaire");
		expect(validate(parse(output))).toEqual({ ok: true });
		expect(errors).toEqual([]);
	});

	it("synchronizes every registered node and restores a Yjs checkpoint", async () => {
		let reg = registry();
		let errors: Error[] = [];
		let provider = {
			awareness: {
				getLocalState: () => null,
				getStates: () => new Map(),
				off() {},
				on() {},
				setLocalState() {},
				setLocalStateField() {},
			},
			connect() {},
			disconnect() {},
			off() {},
			on() {},
		} as unknown as Provider;
		let peer = () => {
			let editor = createHeadlessEditor({ nodes: reg.nodes, onError: error => errors.push(error) });
			let doc = new Y.Doc();
			let binding = createYjsBinding({ editor, id: "plan", doc, docMap: new Map([["plan", doc]]) });
			let stop = editor.registerUpdateListener(
				({ dirtyElements, dirtyLeaves, editorState, normalizedNodes, prevEditorState, tags }) => {
					syncLexicalUpdateToYjs(
						binding,
						provider,
						prevEditorState,
						editorState,
						dirtyElements,
						dirtyLeaves,
						normalizedNodes,
						tags,
					);
				},
			);
			let shared = binding.root.getSharedType();
			let receive: Parameters<typeof shared.observeDeep>[0] = (events, transaction) => {
				if (transaction.origin !== binding) {
					syncYjsChangesToLexical(binding, provider, events, false, () => {});
				}
			};
			shared.observeDeep(receive);
			return {
				editor,
				doc,
				close() {
					stop();
					shared.unobserveDeep(receive);
					doc.destroy();
				},
			};
		};
		let source = peer();
		let target = peer();
		let restored = peer();
		let flush = (client: ReturnType<typeof peer>) =>
			new Promise<void>(resolve => client.editor.update(() => {}, { onUpdate: resolve }));
		try {
			importPlan(source.editor, SAMPLE, { registry: reg });
			let original = exportPlan(source.editor, { registry: reg });
			Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc));
			await flush(target);
			expect(errors).toEqual([]);
			expect(exportPlan(target.editor, { registry: reg })).toBe(original);

			let before = Y.encodeStateVector(target.doc);
			source.editor.update(() => {
				let text = $getRoot().getAllTextNodes().find(node =>
					node.getTextContent() === "Left side."
				);
				expect(text).toBeDefined();
				text!.setTextContent("Edited left side.");
			}, { discrete: true });
			Y.applyUpdate(target.doc, Y.encodeStateAsUpdate(source.doc, before));
			await flush(target);
			expect(errors).toEqual([]);
			let edited = exportPlan(source.editor, { registry: reg });
			expect(edited).toContain("Edited left side.");
			expect(exportPlan(target.editor, { registry: reg })).toBe(edited);

			Y.applyUpdate(restored.doc, Y.encodeStateAsUpdate(target.doc));
			await flush(restored);
			let checkpoint = exportPlan(restored.editor, { registry: reg });
			expect(checkpoint).toBe(edited);
			expect(validate(parse(checkpoint))).toEqual({ ok: true });
			expect(errors).toEqual([]);
		} finally {
			source.close();
			target.close();
			restored.close();
		}
	});

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
