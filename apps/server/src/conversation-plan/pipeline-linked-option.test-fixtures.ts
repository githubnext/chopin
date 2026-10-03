import { applyInference } from "./domain";
import { planEvents } from "./policy";
import { d01RecordedOpening } from "./policy-terminal.test-fixtures";

export function d01LinkedEditorCard() {
	let opening = d01RecordedOpening();
	let state = applyInference(opening.state, planEvents(opening).events[0]!, opening.message);
	let threadId = state.threads[0]!.id;
	let cardId = "01M3QAQ8HM8DVYA9E4N28QCQ7T";
	state.threads[0]!.questionnaireId = cardId;
	let options = [
		{ id: "01M3QAQWM9QHKKX1YV7EEYVX90", label: "Tiptap" },
		{ id: "01M3QAQWMTWFQQNS5DNDG66X4N", label: "Bare ProseMirror" },
		{ id: "01M3QAQWN9TYWMFW3D0EYAZY8H", label: "Lexical" },
		{
			id: "01M3QAQWNRJC3B4P6TD2HHBYKS",
			label: "Native Selection and Range with a custom document model",
		},
	];
	let linkedCards = new Map([[threadId, { cardId, options }]]);
	return { state, threadId, options, linkedCards };
}
