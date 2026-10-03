import type { ExcerptCorrectionAction } from "../../apps/web/src/conversation-plan/analysis-action";

export type Mode = "editable" | "readonly" | "missing-callback" | "inactive";

declare global {
	interface Window {
		analysisFixture: {
			mount: (mode: Mode) => void;
			setEditable: (value: boolean) => void;
			release: () => void;
			hold: boolean;
			fail: boolean;
			calls: ExcerptCorrectionAction[];
		};
	}
}

export let fixtureSource = `
import { createElement } from "react";
import { createRoot } from "react-dom/client";



type Mode = "editable" | "readonly" | "missing-callback" | "inactive";

declare global {
	interface Window {
		analysisFixture: {
			mount: (mode: Mode) => void;
			setEditable: (value: boolean) => void;
			release: () => void;
			hold: boolean;
			fail: boolean;
			calls: ExcerptCorrectionAction[];
		};
	}
}

let messageText = "Prefix: S3 needs encryption. S3 is available.";
let quote = "S3 needs encryption. S3 is available.";
let outcome: ConversationPlan.CandidateOutcome = {
	start: messageText.indexOf(quote),
	end: messageText.length,
	status: "review",
	gate: "target needs review",
	eventIds: [],
};
let thread: ConversationPlan.Thread = {
	id: "thread-1",
	question: "Where should we store data?",
	questionSources: [],
	questionAuthoring: "quoted",
	status: "exploring",
	contributions: [{
		id: "option-1",
		kind: "option",
		text: "S3",
		authoring: "quoted",
		sources: [],
		actor: { kind: "classifier" },
	}],
	stances: [],
	stanceHistory: [],
	decisionHistory: [],
	candidates: [],
	questionnaireId: "card-1",
	version: 7,
};
let fixtureRoot = createRoot(document.querySelector("#fixture")!);
let generation = 0;

function FormFixture({ mode }: { mode: Mode }) {
	let [canEdit, setEditable] = useState(mode !== "readonly");
	window.analysisFixture.setEditable = setEditable;
	let state: ConversationPlan.State = {
		schemaVersion: 1,
		revision: 9,
		events: [],
		threads: [
			{ ...thread, status: mode === "inactive" ? "decided" : "exploring" },
			{ ...thread, id: "discarded", status: "discarded", questionnaireId: "discarded" },
			{ ...thread, id: "unlinked", questionnaireId: undefined },
		],
		queue: [],
		analysis: [],
	};
	let onAddExcerpt = async (action: ExcerptCorrectionAction) => {
		window.analysisFixture.calls.push(action);
		if (window.analysisFixture.fail) {
			window.analysisFixture.fail = false;
			throw new Error("Controlled callback rejection");
		}
		if (window.analysisFixture.hold) {
			await new Promise<void>(resolve => { window.analysisFixture.release = resolve; });
		}
	};
	return createElement(ExcerptCorrection, {
		canEdit,
		linked: false,
		linkedSubspans: [],
		messageId: "message-1",
		messageText,
		onAddExcerpt: mode === "missing-callback" ? undefined : onAddExcerpt,
		outcome,
		quote,
		state,
	});
}

window.analysisFixture = {
	calls: [],
	hold: false,
	fail: false,
	release() {},
	setEditable() {},
	mount(mode) {
		this.calls = [];
		this.hold = false;
		this.fail = false;
		fixtureRoot.render(createElement(FormFixture, { key: ++generation, mode }));
	},
};
`;
