/**
 * Dev-only: a `QuestionnaireStore` holding fixed questionnaires, for rendering
 * the real Decisions pane without a document, a provider or a socket.
 *
 * Reached through the `@chopin/editor/questionnaire-fixtures` subpath only, so
 * the application bundle never imports it.
 */

import { createEditor } from "lexical";
import { DecisionNode, QuestionnaireNode } from "@chopin/dialect";

import { QuestionnaireStore } from "./questionnaires";

import type { Questionnaire } from "@chopin/dialect";
import type { Plan } from "@chopin/protocol";

export { DECIDED } from "./widgets/questionnaire-metadata.test-fixtures";

export function questionnaireFixtureStore(
	values: readonly Questionnaire[],
	{ prose }: { prose?: Plan.ProseAnchors[] } = {},
): QuestionnaireStore {
	let store = new QuestionnaireStore();
	// A detached editor confirms the (empty) document sync, which is what makes
	// an empty pane say "No decisions yet" rather than "Loading decisions".
	store.attach(createEditor({ nodes: [QuestionnaireNode, DecisionNode], onError: () => {} }));
	store.setDocumentSynced(true);
	store.set({
		entries: values.map(value => ({ id: value.id, value })),
		hasPlanContent: true,
		runs: [],
	});
	if (prose) store.prose(prose);
	return store;
}
