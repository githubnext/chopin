/**
 * Asking a question without an agent.
 *
 * The questionnaire flow is the most collaborative thing here and the least
 * reachable: normally only a planning turn produces one. Waiting for the agent
 * to exist before any of it could be exercised would mean building the shared
 * draft, the two-phase resolution and the sidecar blind.
 *
 * Enabled only when `DEV_QUESTIONS` is set. It mints ids and asks, which is
 * exactly what the agent's tool will do — so the path this exercises is the
 * real one, not a rehearsal of it.
 */

import * as Questions from "./service";

import type { Server } from "bun";
import type { Plan } from "../plan/service";
import type { SocketData } from "../wire";

const SAMPLE = {
	questions: [
		{
			header: "Storage",
			question: "Where should room state live?",
			multiple: false,
			options: [
				{ label: "On disk as MDX", description: "Readable, diffable, editable by hand." },
				{ label: "In SQLite", description: "Transactional, but opaque without a client." },
			],
		},
		{
			header: "Scope",
			question: "Which of these belong in the first cut?",
			multiple: true,
			options: [
				{ label: "Anchors", description: "Link a decision to the prose it produced." },
				{ label: "Image uploads", description: "Rather than referencing a URL." },
				{ label: "Export", description: "Download the plan as Markdown." },
			],
		},
	],
};

export function enabled(): boolean {
	return !!process.env.DEV_QUESTIONS;
}

/** Ask the sample questionnaire, and log what comes back. */
export function ask(plan: Plan, server: Server<SocketData>, roomId: string): void {
	void Questions.ask(plan, server, roomId, Questions.identify(SAMPLE))
		.then(ended => {
			console.log(
				`[dev] decisions settled: ${JSON.stringify(ended)}`,
			);
		})
		.catch(err => console.error("[dev] question failed:", err));
}
