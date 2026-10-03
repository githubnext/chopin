import { $createParagraphNode, $getRoot } from "lexical";
import * as Y from "yjs";
import { QuestionnaireNode } from "@chopin/dialect";

import * as Room from "../plan/room";

/** Persist the legacy shared caret run seen between adjacent decision cards. */
export async function storedCardGapDocument(source: string) {
	let document = await Room.create(source);
	try {
		document.editor.update(() => {
			let second = $getRoot().getChildren().filter(node => node instanceof QuestionnaireNode)[1];
			if (!second) throw new Error("two questionnaire nodes are required");
			for (let index = 0; index < 3; index++) second.insertBefore($createParagraphNode());
		}, { discrete: true });
		await Room.settle();
		return {
			epoch: document.epoch,
			source: Room.project(document),
			update: Y.encodeStateAsUpdate(document.doc),
		};
	} finally {
		document.doc.destroy();
	}
}
