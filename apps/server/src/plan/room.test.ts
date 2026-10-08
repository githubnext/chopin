/**
 * The authoritative document, without a socket in sight.
 *
 * These exercise the parts a wire test cannot reach cleanly: what happens to a
 * document when two people edit the same region concurrently, and what happens
 * when an update leaves it in a state the dialect will not accept.
 */

import { describe, expect, it, spyOn } from "bun:test";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$isElementNode,
	$isParagraphNode,
} from "lexical";
import * as Y from "yjs";

import { $importPlan, limits } from "@chopin/dialect";

import { peer, REGISTRY } from "../testing/peer";
import * as room from "./room";

function questionnaire(id: string, question: string, option: string, header: string) {
	return {
		id,
		questions: [{
			id: question,
			header,
			prompt: `What should ${header} be?`,
			multiple: false,
			options: [{ id: option, label: "Choose this" }],
		}],
	};
}

describe("document", () => {
	it("starts empty and projects to nothing", async () => {
		let document = await room.create();
		document.editor.getEditorState().read(() => {
			let first = $getRoot().getFirstChild();
			expect($isParagraphNode(first)).toBe(true);
			expect($getRoot().getChildrenSize()).toBe(1);
		});
		expect(room.project(document)).toBe("");
	});

	it("seeds from canonical source and projects it back unchanged", async () => {
		let source = "# Title\n\nA paragraph.\n";
		let document = await room.create(source);
		expect(room.project(document)).toBe(source);
	});

	it("refuses to seed from source the dialect rejects", async () => {
		await expect(room.create("<script>alert(1)</script>\n")).rejects.toThrow();
	});

	it("gives a joining client only what it is missing", async () => {
		let document = await room.create("# Title\n");
		let whole = room.sync(document);
		let caughtUp = room.sync(document, Y.encodeStateVector(document.doc));

		expect(whole.byteLength).toBeGreaterThan(0);
		expect(caughtUp.byteLength).toBeLessThan(whole.byteLength);
	});
});

describe("questionnaire insertion", () => {
	it("inserts a batch directly after validated prose in input order", async () => {
		let document = await room.create("Related prose.\n\nLater prose.\n");
		let digest = room.digests(document)[0]!;
		let mutation = room.insertQuestionnaires(document, [
			{
				value: questionnaire(
					"01K0N4TR8K7JGM4R1J7PW4R8YJ",
					"01K0N4V4E7Y6P4MJ5WD8XZF3B2",
					"01K0N4W3B7P27CBAEC7A8C8WEA",
					"First",
				),
				at: { index: 0, digest },
			},
			{
				value: questionnaire(
					"01K0N4X2M5R8T3VQ7YB6ZC4DEF",
					"01K0N4Y2M5R8T3VQ7YB6ZC4DEF",
					"01K0N4Z2M5R8T3VQ7YB6ZC4DEF",
					"Second",
				),
				at: { index: 0, digest },
			},
		]);

		expect(mutation).toBeDefined();
		let source = room.project(document);
		expect(source.indexOf("Related prose.")).toBeLessThan(source.indexOf('header="First"'));
		expect(source.indexOf('header="First"')).toBeLessThan(source.indexOf('header="Second"'));
		expect(source.indexOf('header="Second"')).toBeLessThan(source.indexOf("Later prose."));
	});

	it("refuses every insertion when one destination has changed", async () => {
		let document = await room.create("Related prose.\n");
		let digest = room.digests(document)[0]!;

		expect(() =>
			room.insertQuestionnaires(document, [
				{
					value: questionnaire(
						"01K0N4TR8K7JGM4R1J7PW4R8YJ",
						"01K0N4V4E7Y6P4MJ5WD8XZF3B2",
						"01K0N4W3B7P27CBAEC7A8C8WEA",
						"First",
					),
					at: { index: 0, digest },
				},
				{
					value: questionnaire(
						"01K0N4X2M5R8T3VQ7YB6ZC4DEF",
						"01K0N4Y2M5R8T3VQ7YB6ZC4DEF",
						"01K0N4Z2M5R8T3VQ7YB6ZC4DEF",
						"Second",
					),
					at: { index: 0, digest: room.digest("changed") },
				},
			])
		).toThrow(/changed.*read/i);
		expect(room.project(document)).not.toContain("<Questionnaire");
	});
});

describe("concurrent editing", () => {
	/**
	 * The property the whole design rests on: two people editing different
	 * parts of one document end up with the same document, whatever order the
	 * updates arrive in.
	 */
	it("converges when two peers edit different tabs", async () => {
		let source = `<Tabs id="01K0N4TR8K7JGM4R1J7PW4R8YJ">
	<Tab id="01K0N4V4E7Y6P4MJ5WD8XZF3B2" label="One">
		First.
	</Tab>
	<Tab id="01K0N4W3B7P27CBAEC7A8C8WEA" label="Two">
		Second.
	</Tab>
</Tabs>
`;
		let server = await room.create(source);
		let state = room.sync(server);

		let alice = peer();
		let bob = peer();
		Y.applyUpdate(alice.doc, state, "remote");
		Y.applyUpdate(bob.doc, state, "remote");
		await room.settle();

		// Each edits a different tab, neither having seen the other's change.
		let before = { alice: Y.encodeStateVector(alice.doc), bob: Y.encodeStateVector(bob.doc) };

		alice.editor.update(() => {
			let tab = $getRoot().getFirstChild();
			let first = $isElementNode(tab) ? tab.getFirstChild() : null;
			if ($isElementNode(first)) first.getFirstChild()?.remove();
		}, { discrete: true });

		bob.editor.update(() => {
			let tabs = $getRoot().getFirstChild();
			let second = $isElementNode(tabs) ? tabs.getLastChild() : null;
			if ($isElementNode(second)) second.getFirstChild()?.remove();
		}, { discrete: true });

		let fromAlice = Y.encodeStateAsUpdate(alice.doc, before.alice);
		let fromBob = Y.encodeStateAsUpdate(bob.doc, before.bob);

		// The server sees them in one order, each peer in the other.
		await room.apply(server, [fromAlice, fromBob]);
		Y.applyUpdate(alice.doc, fromBob, "remote");
		Y.applyUpdate(bob.doc, fromAlice, "remote");
		await room.settle();

		let projected = room.project(server);
		expect(Y.encodeStateAsUpdate(alice.doc).byteLength)
			.toBe(Y.encodeStateAsUpdate(bob.doc).byteLength);
		expect(projected).not.toContain("First.");
		expect(projected).not.toContain("Second.");
	});

	it("survives the same update arriving twice", async () => {
		let server = await room.create("# Title\n");
		let client = peer();
		Y.applyUpdate(client.doc, room.sync(server), "remote");
		await room.settle();

		let before = Y.encodeStateVector(client.doc);
		client.editor.update(() => {
			$importPlan("# Title\n\nAdded.\n", { registry: REGISTRY, validate: false });
		}, { discrete: true });
		let update = Y.encodeStateAsUpdate(client.doc, before);

		await room.apply(server, [update]);
		let once = room.project(server);
		await room.apply(server, [update]);

		expect(room.project(server)).toBe(once);
	});
});

describe("recovery", () => {
	it("destroys a scratch restoration when a journal update throws", async () => {
		let document = await room.create("# Title\n");
		let checkpoint = Y.encodeStateAsUpdate(document.doc);
		let destroy = spyOn(Y.Doc.prototype, "destroy");
		try {
			await expect(
				room.restore(document.epoch, checkpoint, "# Title\n", [{
					epoch: document.epoch,
					update: new Uint8Array([255]),
				}]),
			).rejects.toThrow();
			expect(destroy).toHaveBeenCalledTimes(1);
		} finally {
			destroy.mockRestore();
			document.doc.destroy();
		}
	});

	it("restores a checkpoint stored with an empty paragraph's former blank line", async () => {
		let document = await room.create("# Title\n");
		document.editor.update(() => $getRoot().append($createParagraphNode()), { discrete: true });
		await room.settle();
		let checkpoint = Y.encodeStateAsUpdate(document.doc);
		try {
			let restored = await room.restore(document.epoch, checkpoint, "# Title\n\n", []);
			expect(room.project(restored)).toBe("# Title\n");
			restored.doc.destroy();
			await expect(room.restore(document.epoch, checkpoint, "# Other\n", [])).rejects.toThrow(
				"stored plan source does not match its Yjs checkpoint",
			);
		} finally {
			document.doc.destroy();
		}
	});

	/**
	 * A rejected batch cannot be undone — Yjs has no such operation — so the
	 * document is rebuilt from the last state that was known to be good.
	 */
	it("reports an update that leaves the document invalid", async () => {
		let document = await room.create("# Title\n");
		room.mark(document);

		let client = peer();
		Y.applyUpdate(client.doc, room.sync(document), "remote");
		await room.settle();

		// A Callout with no id is well-formed MDX and outside the dialect.
		let before = Y.encodeStateVector(client.doc);
		client.editor.update(() => {
			$importPlan('<Callout type="note">\n\tText.\n</Callout>\n', {
				registry: REGISTRY,
				validate: false,
			});
		}, { discrete: true });

		let outcome = await room.apply(document, [Y.encodeStateAsUpdate(client.doc, before)]);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.issues.length).toBeGreaterThan(0);
	});

	/**
	 * The stricter URL rules arrived after documents were stored. They judge
	 * what a change brings in, so a document already holding such a link keeps
	 * opening, restoring and taking edits instead of failing every projection.
	 */
	it("keeps opening and editing a stored document with a link the newer URL rules refuse", async () => {
		let source = "Read [the notes](docs\\notes.md).\n";
		let document = await room.create(source);
		let stored = room.project(document);
		expect(stored).toContain("docs\\");
		room.mark(document);

		let restored = await room.restore(
			document.epoch,
			Y.encodeStateAsUpdate(document.doc),
			stored,
			[],
		);
		try {
			let client = peer();
			Y.applyUpdate(client.doc, room.sync(restored), "remote");
			await room.settle();
			let before = Y.encodeStateVector(client.doc);
			client.editor.update(() => {
				$importPlan(`${stored}\nAdded.\n`, { registry: REGISTRY, validate: false });
			}, { discrete: true });
			let outcome = await room.apply(restored, [Y.encodeStateAsUpdate(client.doc, before)]);
			expect(outcome.ok).toBe(true);
			expect(room.project(restored)).toBe(`${stored}\nAdded.\n`);

			// A new link of the same kind is still refused.
			before = Y.encodeStateVector(client.doc);
			client.editor.update(() => {
				$importPlan(`${stored}\nAdded [elsewhere](//evil.com).\n`, {
					registry: REGISTRY,
					validate: false,
				});
			}, { discrete: true });
			let refused = await room.apply(restored, [Y.encodeStateAsUpdate(client.doc, before)]);
			expect(refused.ok).toBe(false);
			if (!refused.ok) expect(refused.issues).toContain("bad-link");

			// So is a hidden character, which the stored text did not carry.
			let hidden = `https://ex${String.fromCharCode(0x200b)}ample.com`;
			before = Y.encodeStateVector(client.doc);
			client.editor.update(() => {
				$importPlan(`${stored}\nAdded [elsewhere](${hidden}).\n`, {
					registry: REGISTRY,
					validate: false,
				});
			}, { discrete: true });
			let hiding = await room.apply(restored, [Y.encodeStateAsUpdate(client.doc, before)]);
			expect(hiding.ok).toBe(false);
			if (!hiding.ok) expect(hiding.issues).toContain("bad-link");
		} finally {
			restored.doc.destroy();
			document.doc.destroy();
		}
	});

	it("with questions open, refuses a human edit that grows into the expiry reserve but allows one that shrinks", async () => {
		let filler = "x".repeat(limits.MAX_SOURCE_BYTES - 40);
		let document = await room.create(`# T\n\n${filler}\n\nTail.\n`);
		room.mark(document);
		expect(room.fitsExpiry(room.project(document), 1)).toBe(false);

		let client = peer();
		Y.applyUpdate(client.doc, room.sync(document), "remote");
		await room.settle();

		let before = Y.encodeStateVector(client.doc);
		client.editor.update(() => {
			let paragraph = $createParagraphNode();
			paragraph.append($createTextNode("More."));
			$getRoot().append(paragraph);
		}, { discrete: true });
		let grown = await room.apply(
			document,
			[Y.encodeStateAsUpdate(client.doc, before)],
			undefined,
			1,
		);
		expect(grown.ok).toBe(false);

		let fresh = await room.rebuild(document);
		let shrinker = peer();
		Y.applyUpdate(shrinker.doc, room.sync(fresh), "remote");
		await room.settle();
		let start = Y.encodeStateVector(shrinker.doc);
		shrinker.editor.update(() => {
			$getRoot().getLastChild()?.remove();
		}, { discrete: true });
		let shrunk = await room.apply(
			fresh,
			[Y.encodeStateAsUpdate(shrinker.doc, start)],
			undefined,
			1,
		);
		expect(shrunk.ok).toBe(true);
		expect(room.project(fresh)).not.toContain("Tail.");
	});

	// Projection and its re-parse run on the event loop. Brackets used to make
	// both quadratic, so one large paste held the loop for minutes and the
	// storage writer lease, renewed on a timer, expired underneath the server.
	it("accepts and refuses large bracket-heavy pastes without stalling the event loop", async () => {
		let document = await room.create("# T\n");
		room.mark(document);
		let client = peer();
		Y.applyUpdate(client.doc, room.sync(document), "remote");
		await room.settle();

		let longest = 0;
		let last = performance.now();
		let heartbeat = setInterval(() => {
			let now = performance.now();
			longest = Math.max(longest, now - last);
			last = now;
		}, 10);
		try {
			let paste = async () => {
				let before = Y.encodeStateVector(client.doc);
				client.editor.update(() => {
					let paragraph = $createParagraphNode();
					paragraph.append($createTextNode("[a]".repeat(limits.MAX_SOURCE_BYTES / 6)));
					$getRoot().append(paragraph);
				}, { discrete: true });
				return room.apply(document, [Y.encodeStateAsUpdate(client.doc, before)], undefined, 1);
			};
			expect((await paste()).ok).toBe(true);
			let refused = await paste();
			expect(refused.ok ? [] : refused.issues).toEqual(["source-too-large"]);
		} finally {
			clearInterval(heartbeat);
		}
		expect(longest).toBeLessThan(5_000);
	});

	it("rebuilds to the last known-good state under a fresh epoch", async () => {
		let document = await room.create("# Title\n");
		room.mark(document);
		let original = document.epoch;

		let client = peer();
		Y.applyUpdate(client.doc, room.sync(document), "remote");
		await room.settle();
		let before = Y.encodeStateVector(client.doc);
		client.editor.update(() => {
			$importPlan('<Callout type="note">\n\tText.\n</Callout>\n', {
				registry: REGISTRY,
				validate: false,
			});
		}, { discrete: true });
		await room.apply(document, [Y.encodeStateAsUpdate(client.doc, before)]);

		let rebuilt = await room.rebuild(document);
		expect(rebuilt.epoch).not.toBe(original);
		expect(room.project(rebuilt)).toBe("# Title\n");
	});
});

describe("round trip proof", () => {
	it("accepts source that survives import and export", () => {
		expect(() => room.validate("# Title\n\nText with **bold**.\n")).not.toThrow();
	});

	it("rejects source the dialect does not allow", () => {
		expect(() => room.validate('<Unknown id="x" />\n')).toThrow();
	});
});
