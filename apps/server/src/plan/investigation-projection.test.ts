/**
 * An Investigation reference is an atomic decorator that only its record can
 * authorize. A browser may add one for an existing record and remove one once
 * its work has settled; the server's headless mirror must sync it like any node.
 */

import { describe, expect, it } from "bun:test";
import { $createInvestigationNode, InvestigationNode } from "@chopin/dialect";
import { $getRoot, $nodesOfType } from "lexical";
import * as Y from "yjs";

import { peer } from "../testing/peer";
import * as room from "./room";

const ID = "2b7e0c4a-5f1d-4e2a-9c3b-7d8e9f0a1b2c";

async function connected(source: string) {
	let document = await room.create(source);
	room.mark(document);
	let client = peer();
	Y.applyUpdate(client.doc, room.sync(document), "remote");
	await room.settle();
	return { document, client };
}

function edit(client: ReturnType<typeof peer>, change: () => void) {
	let before = Y.encodeStateVector(client.doc);
	client.editor.update(change, { discrete: true });
	return Y.encodeStateAsUpdate(client.doc, before);
}

describe("Investigation references", () => {
	it("accept a browser insertion only when the record authorizes it", async () => {
		let seen: string[] = [];
		let { document, client } = await connected("# Title\n");
		let update = edit(client, () => $getRoot().append($createInvestigationNode(ID)));
		let outcome = await room.apply(document, [update], async (id, action, type) => {
			seen.push(`${type}:${action}:${id}`);
			return true;
		});
		expect(outcome).toMatchObject({ ok: true, researchProjections: [] });
		expect(seen).toEqual([`Investigation:add:${ID}`]);
		expect(room.project(document)).toBe(`# Title\n\n<Investigation id="${ID}" />\n`);

		let refused = await connected("# Title\n");
		let forged = edit(refused.client, () => $getRoot().append($createInvestigationNode(ID)));
		expect(await room.apply(refused.document, [forged], async () => false)).toEqual({
			ok: false,
			issues: ["protected-projection"],
		});
	});

	it("refuse removal while the record keeps the reference", async () => {
		let { document, client } = await connected(`# Title\n\n<Investigation id="${ID}" />\n`);
		let update = edit(client, () => {
			for (let node of $nodesOfType(InvestigationNode)) node.remove();
		});
		expect(await room.apply(document, [update], async () => false)).toEqual({
			ok: false,
			issues: ["protected-projection"],
		});
	});

	it("round-trips through the server's headless Lexical and Yjs mirror", async () => {
		let source = `# Title\n\nBefore.\n\n<Investigation id="${ID}" />\n\nAfter.\n`;
		let document = await room.create(source);
		expect(room.project(document)).toBe(source);
		let client = peer();
		Y.applyUpdate(client.doc, room.sync(document), "remote");
		await room.settle();
		let ids: string[] = [];
		client.editor.getEditorState().read(() => {
			ids = $nodesOfType(InvestigationNode).map(node => node.getId());
		});
		expect(ids).toEqual([ID]);
		let restored = await room.restore(
			document.epoch,
			Y.encodeStateAsUpdate(document.doc),
			room.project(document),
			[],
		);
		expect(room.project(restored)).toBe(source);
		let inserted = room.insertInvestigation(restored, crypto.randomUUID());
		expect(inserted.mutation).toBeDefined();
		expect(room.insertInvestigation(restored, ID)).toEqual({
			mutation: undefined,
			placement: "present",
		});
	});
});

describe("Planner investigation placement", () => {
	const OTHER = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";

	function at(document: room.Document, index: number) {
		return { index, digest: room.digests(document)[index]! };
	}

	it("puts the card directly after the addressed block", async () => {
		let document = await room.create("# Title\n\nCold start is slow.\n\nNext steps.\n");
		let placed = room.insertInvestigation(document, ID, at(document, 1));
		expect(placed.placement).toBe("anchored");
		expect(room.project(document)).toBe(
			`# Title\n\nCold start is slow.\n\n<Investigation id="${ID}" />\n\nNext steps.\n`,
		);
	});

	it("keeps earlier cards on the same block in order", async () => {
		let document = await room.create("# Title\n\nCold start is slow.\n\nNext steps.\n");
		let target = at(document, 1);
		room.insertInvestigation(document, ID, target);
		expect(room.insertInvestigation(document, OTHER, target).placement).toBe("anchored");
		expect(room.project(document)).toBe(
			`# Title\n\nCold start is slow.\n\n<Investigation id="${ID}" />\n\n`
				+ `<Investigation id="${OTHER}" />\n\nNext steps.\n`,
		);
	});

	it("follows a block that moved to a new index by its unique digest", async () => {
		let document = await room.create("# Title\n\nCold start is slow.\n");
		let target = at(document, 1);
		let moved = await room.create("# Title\n\nA new opening.\n\nCold start is slow.\n");
		expect(room.resolveBlock(moved, target)).toBe(2);
		expect(room.insertInvestigation(moved, ID, target).placement).toBe("anchored");
		expect(room.project(moved)).toBe(
			`# Title\n\nA new opening.\n\nCold start is slow.\n\n<Investigation id="${ID}" />\n`,
		);
	});

	it("appends rather than guess when the block is gone or repeated", async () => {
		let document = await room.create("# Title\n\nCold start is slow.\n\nEnd.\n");
		let target = at(document, 1);
		let changed = await room.create("# Title\n\nCold start is fast.\n\nEnd.\n");
		expect(room.resolveBlock(changed, target)).toBeUndefined();
		expect(room.insertInvestigation(changed, ID, target).placement).toBe("appended");
		expect(room.project(changed)).toBe(
			`# Title\n\nCold start is fast.\n\nEnd.\n\n<Investigation id="${ID}" />\n`,
		);

		let repeated = await room.create(
			"# Title\n\nA new opening.\n\nCold start is slow.\n\nCold start is slow.\n",
		);
		expect(room.resolveBlock(repeated, target)).toBeUndefined();
		expect(room.insertInvestigation(repeated, ID, target).placement).toBe("appended");
	});

	it("appends when no block is given", async () => {
		let document = await room.create("# Title\n\nCold start is slow.\n");
		expect(room.insertInvestigation(document, ID).placement).toBe("appended");
		expect(room.project(document)).toBe(
			`# Title\n\nCold start is slow.\n\n<Investigation id="${ID}" />\n`,
		);
	});
});
