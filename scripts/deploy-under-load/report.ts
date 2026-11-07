/** The report of a load run: its shape, and the summary a person reads. */
import type { EditCheck, Gate, Summary, TurnCheck } from "./analysis";
import type { HandOverRecord } from "./handover";

export type HandOverReport = Omit<HandOverRecord, "http"> & {
	http: Omit<HandOverRecord["http"], "failures"> & {
		failures: Array<{ method: string; path: string; status?: number }>;
	};
	clients: {
		losses: number;
		announced: number;
		/** From the socket closing to the document being open again, which a tab shows past 1.5 s. */
		gapMs: Summary;
		/** Past what a tab waits before it says so: the gate. */
		notices: number;
		/** Past the design's 1.5 s grace: reported, not gated. */
		pastGrace: number;
		/** Where the time went: the wait before the first attempt, its upgrade, and the document's open. */
		firstAttemptMs: Summary;
		upgradeMs: Summary;
		openMs: Summary;
		/** The upgrade of attempts that began at the rescue point, 1.2 s after the loss. */
		upgradeAtRescueMs: Summary;
		attempts: number;
		failedAttempts: number;
	};
	planners: { resumeMs: Summary; resumed: number; misses: number };
	resets: number;
	abandoned: number;
	/** How busy the old process was in the ten seconds before the signal and the new one in the five after it was ready, where measured. */
	/** How long edits took to be acknowledged in the ten seconds before the signal. */
	ackBeforeMs: Summary;
	cpuPercent?: { oldBefore: Summary; newAfter: Summary };
};

export type Report = {
	version: 1;
	startedAt: string;
	durationMs: number;
	config: Record<string, unknown>;
	environment: { mode: string; proxy: string };
	workload: {
		documents: number;
		editors: number;
		wordsTyped: number;
		updatesAcknowledged: number;
		ackMs: Summary;
		outboxPeak: number;
		requests: Record<string, number>;
		requestsQueued: Record<string, number>;
		retriedRequests: number;
		mcp: { sessions: number; calls: number; failures: unknown[] };
		api: { calls: number; failures: unknown[] };
		connector: { reopened: number; withdrawn: string[] };
		build?: { state: string; error?: string };
	};
	handOvers: HandOverReport[];
	edits: EditCheck[];
	turns: TurnCheck;
	database: { peakConnections: number };
	driver: { loopLagMs: Summary };
	gates: Gate[];
	passed: boolean;
};

const ms = (value: number | undefined) => value === undefined ? "never" : `${value} ms`;

export function render(report: Report): string {
	let lines: string[] = [];
	let { workload } = report;
	lines.push(
		"",
		`Deploy under load: ${report.environment.mode}, behind ${report.environment.proxy}`,
		`${workload.editors} editors on ${workload.documents} documents typed ${workload.wordsTyped} words `
			+ `(${workload.updatesAcknowledged} updates acknowledged in p50 ${workload.ackMs.p50} / p95 ${workload.ackMs.p95} / max ${workload.ackMs.max} ms, outbox peak ${workload.outboxPeak}); `
			+ `${report.handOvers.length} hand-overs in ${Math.round(report.durationMs / 1000)} s; `
			+ `${workload.mcp.calls} MCP calls; peak ${report.database.peakConnections} database connections; `
			+ `driver timers late by at most ${report.driver.loopLagMs.max} ms`,
		`Planner requests acknowledged: ${
			Object.entries(workload.requests).map(([kind, count]) => `${count} ${kind}`).join(", ")
			|| "none"
		}; told they were queued: ${
			JSON.stringify(workload.requestsQueued)
		}; sent again after a lost connection: ${workload.retriedRequests}; `
			+ `rows ${JSON.stringify(report.turns.rows)}`,
		"",
		"Each hand-over, in ms from the old process hearing SIGTERM",
		"  #  told>unready  listener  released  acquired  ready  first served  | clients: lost  gap p50/p95/max  upgrade@1.2s max  | Planners resumed (max ms)",
	);
	for (let item of report.handOvers) {
		let at = (name: string) => String(item.sinceTold[name] ?? "-").padStart(8);
		let served = item.http.gapMs === undefined || item.sinceTold.released === undefined
			? "never"
			: String(item.sinceTold.released + item.http.gapMs);
		lines.push(
			`  ${String(item.index).padStart(1)}  ${at("unready")}  ${at("listenerStopped")}  ${
				at("released")
			}  ${at("acquired")}  ${at("ready")}  ${served.padStart(12)}`
				+ `  |  ${
					String(item.clients.losses).padStart(6)
				}  ${item.clients.gapMs.p50}/${item.clients.gapMs.p95}/${item.clients.gapMs.max}`
				+ `  ${String(item.clients.upgradeAtRescueMs.max).padStart(8)}`
				+ `  |  ${item.planners.resumed} (${item.planners.resumeMs.max})`,
		);
		lines.push(
			`     a client's time to be back, p50/p95/max in ms: waiting for its first attempt ${item.clients.firstAttemptMs.p50}/${item.clients.firstAttemptMs.p95}/${item.clients.firstAttemptMs.max}, `
				+ `upgrade ${item.clients.upgradeMs.p50}/${item.clients.upgradeMs.p95}/${item.clients.upgradeMs.max}, `
				+ `opening the document ${item.clients.openMs.p50}/${item.clients.openMs.p95}/${item.clients.openMs.max}; `
				+ `${item.clients.pastGrace} of ${item.clients.losses} past the design's 1.5 s grace, ${item.clients.notices} past what a tab waits`,
		);
		lines.push(
			`     cut ${JSON.stringify(item.cut.phases)}; readiness refused ${
				item.cut.refused ?? "never asked"
			}; closed without an answer ${item.cut.abandoned.length}; `
				+ `first answer ${
					ms(item.http.gapMs)
				} after the release; ${item.http.failures.length} of ${item.http.requests} requests not answered 2xx; `
				+ `new process ready ${ms(item.ready?.afterLeaseMs)} after taking the lease; `
				+ `edits acknowledged in p50 ${item.ackBeforeMs.p50} / p95 ${item.ackBeforeMs.p95} ms before the signal`
				+ (item.cpuPercent
					? `; processor use of the old process before the signal p50 ${item.cpuPercent.oldBefore.p50}% max ${item.cpuPercent.oldBefore.max}%, `
						+ `of the new one after ready p50 ${item.cpuPercent.newAfter.p50}% max ${item.cpuPercent.newAfter.max}%`
					: ""),
		);
	}
	lines.push("", "Gates");
	for (let gate of report.gates) {
		lines.push(`  ${gate.passed ? "pass" : "FAIL"}  ${gate.name}: ${gate.detail}`);
	}
	lines.push("", report.passed ? "Every gate passed." : "A gate failed.");
	return lines.join("\n");
}
