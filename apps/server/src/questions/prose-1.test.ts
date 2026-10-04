import { expect, it } from "bun:test";
import { $createParagraphNode, $createTextNode, $getRoot, $isParagraphNode } from "lexical";

import * as edit from "../plan/edit";
import * as room from "../plan/room";

import * as Prose from "./prose";
import * as Store from "./store";

import type { Plan as RoomPlan } from "../plan/service";

import { subject } from "./prose.test-fixtures";

// Whole archive 446a9779a937fa5be7cd3eb52fd7f3023d691ed2 callbacks and data; import/fixture wrappers only.
it("keeps the original Yjs block when a person edits it, even beside identical prose", async () => {
	let { document, anchor } = await subject(
		"# Title\n\nDecision prose.\n\nDecision prose.\n",
	);
	let original = room.resolveAnchor(document, anchor);
	try {
		document.editor.update(() => {
			let paragraph = $getRoot().getChildren()[2];
			if (!$isParagraphNode(paragraph)) throw new Error("missing paragraph");
			paragraph.append($createTextNode(" People may add organisations later."));
		}, { discrete: true });
		await room.settle();

		let [carried] = Prose.carry(document, [anchor]);
		expect(carried?.orphaned).toBeUndefined();
		expect(room.resolveAnchor(document, carried!)).toBe(original);
		expect(carried?.digest).toBe(room.digests(document)[2]);
		expect(carried?.digest).not.toBe(room.digests(document)[1]);
	} finally {
		document.doc.destroy();
	}
});

it("follows a moved paragraph when its old Yjs position is gone", async () => {
	let { document, anchor } = await subject();
	try {
		let plan = {
			document,
			revision: 1,
			outlines: new Map(),
			questions: Store.create(),
		} as RoomPlan;
		edit.apply(plan, 1, [{ op: "move", index: 2, to: 1 }]);
		expect(room.resolveAnchor(document, anchor)).toBeUndefined();

		let [carried] = Prose.carry(document, [anchor]);
		expect(carried?.orphaned).toBeUndefined();
		expect(room.matchesAnchor(document, carried!, 1)).toBe(true);
	} finally {
		document.doc.destroy();
	}
});

it("keeps a human-moved paragraph at its new position", async () => {
	let { document, anchor } = await subject();
	try {
		document.editor.update(() => {
			let children = $getRoot().getChildren();
			children[1]!.insertBefore(children[2]!);
		}, { discrete: true });
		await room.settle();

		let [carried] = Prose.carry(document, [anchor]);
		expect(carried?.orphaned).toBeUndefined();
		expect(room.matchesAnchor(document, carried!, 1)).toBe(true);
		expect(carried?.digest).toBe(room.digests(document)[1]);
	} finally {
		document.doc.destroy();
	}
});

it("orphans a deleted paragraph instead of finding a different block", async () => {
	let { document, anchor } = await subject();
	try {
		document.editor.update(() => {
			$getRoot().getChildren()[2]!.remove();
		}, { discrete: true });
		await room.settle();

		let [carried] = Prose.carry(document, [anchor]);
		expect(carried?.orphaned).toBe(true);
		expect(Prose.orphaned(carried ? [carried] : [])).toBe(true);
	} finally {
		document.doc.destroy();
	}
});

it("does not retarget a deleted paragraph to its identical surviving neighbour", async () => {
	let { document, anchor } = await subject("# Title\n\nSame.\n\nSame.\n");
	let previous = room.project(document);
	try {
		document.editor.update(() => {
			$getRoot().getChildren()[2]!.remove();
		}, { discrete: true });
		await room.settle();

		let [carried] = Prose.carry(document, [anchor], previous);
		expect(room.project(document)).toBe("# Title\n\nSame.\n");
		expect(carried?.orphaned).toBe(true);
		expect(room.resolveAnchor(document, carried!)).toBeUndefined();
	} finally {
		document.doc.destroy();
	}
});

it("recovers a unique paragraph pasted in the next document edit", async () => {
	let { document, anchor } = await subject();
	try {
		let beforeCut = room.project(document);
		document.editor.update(() => {
			$getRoot().getChildren()[2]!.remove();
		}, { discrete: true });
		await room.settle();
		let [cut] = Prose.carry(document, [anchor], beforeCut);
		expect(cut).toMatchObject({ orphaned: true, recoverOnNextEdit: true });

		let beforePaste = room.project(document);
		document.editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode("Decision prose.")));
		}, { discrete: true });
		await room.settle();
		let [pasted] = Prose.carry(document, [cut!], beforePaste);
		expect(pasted?.orphaned).toBeUndefined();
		expect(pasted?.recoverOnNextEdit).toBeUndefined();
		expect(room.matchesAnchor(document, pasted!, 2)).toBe(true);
	} finally {
		document.doc.destroy();
	}
});

it("does not recover after an unrelated edit or from an originally duplicate block", async () => {
	let { document, anchor } = await subject();
	try {
		let beforeCut = room.project(document);
		document.editor.update(() => $getRoot().getChildren()[2]!.remove(), { discrete: true });
		await room.settle();
		let [cut] = Prose.carry(document, [anchor], beforeCut);
		let beforeUnrelated = room.project(document);
		document.editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode("Unrelated.")));
		}, { discrete: true });
		await room.settle();
		let [expired] = Prose.carry(document, [cut!], beforeUnrelated);
		expect(expired?.recoverOnNextEdit).toBeUndefined();
		let beforeLater = room.project(document);
		document.editor.update(() => {
			$getRoot().append($createParagraphNode().append($createTextNode("Decision prose.")));
		}, { discrete: true });
		await room.settle();
		let [later] = Prose.carry(document, [expired!], beforeLater);
		expect(later?.orphaned).toBe(true);
	} finally {
		document.doc.destroy();
	}

	let duplicate = await subject("# Title\n\nDecision prose.\n\nDecision prose.\n");
	try {
		let beforeCut = room.project(duplicate.document);
		duplicate.document.editor.update(() => $getRoot().getChildren()[2]!.remove(), {
			discrete: true,
		});
		await room.settle();
		let [cut] = Prose.carry(duplicate.document, [duplicate.anchor], beforeCut);
		expect(cut?.orphaned).toBe(true);
		expect(cut?.recoverOnNextEdit).toBeUndefined();
	} finally {
		duplicate.document.doc.destroy();
	}
});

it("does not leave recovery open when the current prose is ambiguous", async () => {
	let { document, anchor } = await subject();
	try {
		let previous = room.project(document);
		document.editor.update(() => {
			$getRoot().getChildren()[2]!.remove();
			for (let index = 0; index < 2; index++) {
				$getRoot().append($createParagraphNode().append($createTextNode("Decision prose.")));
			}
		}, { discrete: true });
		await room.settle();
		let [ambiguous] = Prose.carry(document, [anchor], previous);
		expect(ambiguous?.orphaned).toBe(true);
		expect(ambiguous?.recoverOnNextEdit).toBeUndefined();
		let beforeDelete = room.project(document);
		document.editor.update(() => $getRoot().getChildren()[3]!.remove(), {
			discrete: true,
		});
		await room.settle();
		let [remaining] = Prose.carry(document, [ambiguous!], beforeDelete);
		expect(remaining?.orphaned).toBe(true);
	} finally {
		document.doc.destroy();
	}
});

it("orphans an unresolved position when the digest matches two blocks", async () => {
	let { document, anchor } = await subject();
	try {
		let rotated = await room.replace(
			"# Title\n\nDecision prose.\n\nFirst.\n\nDecision prose.\n",
		);
		try {
			let [carried] = Prose.carry(rotated, [anchor]);
			expect(carried?.orphaned).toBe(true);
			expect(room.resolveAnchor(rotated, carried!)).toBeUndefined();
		} finally {
			rotated.doc.destroy();
		}
	} finally {
		document.doc.destroy();
	}
});
