import type { ImplementationSnapshot } from "@chopin/protocol/implementation";

/** What holds Build back by name. Open decisions never do: the coding agent assumes an answer. */
export type BuildBlocker = { kind: "investigation"; id: string; title: string };

export function buildBlockers(snapshot: ImplementationSnapshot | undefined): BuildBlocker[] {
	return (snapshot?.buildInvestigations ?? []).map(investigation => ({
		kind: "investigation",
		id: investigation.id,
		title: investigation.brief,
	}));
}

export function buildBlockerSummary(items: readonly BuildBlocker[]) {
	return {
		tone: "investigation" as const,
		label: `${items.length} investigation${items.length === 1 ? "" : "s"} left`,
	};
}
