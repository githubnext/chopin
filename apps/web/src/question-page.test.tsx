import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Question } from "@chopin/protocol";
import type { QuestionnaireEntry } from "@chopin/editor";
import { InvestigationReference } from "./experiments/card";
import { ExperimentStore } from "./experiments/store";
import { QuestionPagePanel } from "./question-page";

test("a saved decision page shows its live investigation and keeps the answer read-only", () => {
	let entry: QuestionnaireEntry = {
		id: "decision",
		value: {
			id: "decision",
			questions: [{
				id: "answer",
				header: "Storage",
				prompt: "Where should state live?",
				response: "text",
				multiple: false,
				options: [],
				answer: "Keep it on disk.",
			}],
		},
	};
	let meta: Question.CardMeta = {
		status: "decided",
		origin: "human",
		involved: ["ana"],
		history: [],
		optionOrigins: {},
		refining: false,
		hasProse: false,
		proseOrphaned: false,
		findings: [{
			id: "finding",
			kind: "spike",
			status: "running",
			ref: "investigation",
			by: "ana",
			at: 1,
		}],
	};
	let store = new ExperimentStore("root");
	store.values.set("investigation", {
		id: "investigation",
		documentId: "root",
		revision: 1,
		brief: "Measure filesystem storage",
		requester: "ana",
		state: "running",
		generation: 1,
		expiresAt: Date.now() + 60_000,
		createdAt: 1,
		updatedAt: 1,
		progress: "Comparing writes in the local checkout",
		views: {},
		decisions: [],
		input: {
			id: "investigation",
			documentId: "root",
			brief: "Measure filesystem storage",
			context: "Document context",
			requester: "ana",
			authorizer: "ana",
			source: { repositoryId: "R_score", repository: "octo-org/score", commit: "a".repeat(40) },
		},
	});
	let root = {
		entries: [entry],
		metadata: new Map([[entry.id, meta]]),
		canEdit: true,
		connected: true,
		investigations: {
			render: (id: string) =>
				createElement(InvestigationReference, {
					store,
					id,
					userId: "ana",
					canEdit: true,
					locked: false,
				}),
		},
	};
	let markup = renderToStaticMarkup(createElement(QuestionPagePanel, { entry, meta, root }));
	expect(markup).toContain("Keep it on disk.");
	expect(markup).toContain('disabled=""');
	expect(markup).toContain("Measure filesystem storage");
	expect(markup).toContain("Comparing writes in the local checkout");
	expect(markup).toMatch(/<button(?![^>]*disabled)[^>]*>Stop<\/button>/);
	expect(markup).not.toContain("Remove investigation");
	expect(markup).not.toContain(">Save<");
});
