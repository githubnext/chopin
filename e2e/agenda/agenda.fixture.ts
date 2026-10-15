import type { Agenda } from "../../packages/protocol/index";

declare global {
	interface Window {
		agendaFixture: {
			opened: string[];
			channel(id: string): void;
			openReport: boolean;
		};
	}
}

export let limits: Agenda.Limits = {
	maxQuestions: 6,
	maxInvestigations: 3,
	maxSessions: 14,
	maxAssessments: 5,
	minIntervalMs: 300_000,
	durationMs: 86_400_000,
	requestTimeoutMs: 900_000,
};

export function response(state: Agenda.State | null = "active"): Agenda.Response {
	return {
		available: true,
		canEdit: true,
		limits,
		agenda: state === null ? null : {
			channelId: "document-a",
			revision: 3,
			generation: 1,
			state,
			scope: "Explore discoverability of open decisions in collaborative writing tools.",
			questions: [{
				id: "question-a",
				question: "How do other editors introduce open decisions?",
				reason: "Help people find the next useful choice.",
				evidenceNeed: "Documented onboarding patterns with public examples.",
				priority: 1,
				state: state === "active" ? "running" : "queued",
			}],
			expiresAt: state === "active" ? "2026-10-15T06:00:00.000Z" : undefined,
			investigations: state === "active" ? 1 : 0,
			reservedSessions: state === "active" ? 4 : 0,
			assessments: 1,
			updatedAt: "2026-10-14T06:00:00.000Z",
		},
	};
}

export let binding = `
import { useState as useFixtureState } from "react";
import { createRoot } from "react-dom/client";
import { useMotionInput } from "../motion-input";

window.agendaFixture = { opened: [], channel() {}, openReport: true };
function AgendaFixture() {
	let [open, setOpen] = useFixtureState(false);
	let [channel, setChannel] = useFixtureState("document-a");
	useMotionInput();
	window.agendaFixture.channel = setChannel;
	return <main>
		<button className="btn btn-md btn-secondary" onClick={() => setOpen(true)}>Research agenda</button>
		<button className="btn btn-md btn-secondary">Outside</button>
		<ResearchAgenda channelId={channel} open={open} onDismiss={() => setOpen(false)}
			onOpenChild={async child => {
				window.agendaFixture.opened.push(child.id);
				return window.agendaFixture.openReport;
			}} />
	</main>;
}
createRoot(document.querySelector("#fixture")!).render(<AgendaFixture />);
`;
