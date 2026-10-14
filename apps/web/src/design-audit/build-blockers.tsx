import { useState } from "react";
import { BuildPlanButton } from "../build-plan-button";
import { AuditPlate } from "./frame";

import type { BuildPlan } from "../build-plan-button";
import type { BuildBlocker } from "../build-blockers";

let noop = () => {};
let build: BuildPlan = {
	look: { kind: "plan", blocked: "Waiting on decisions and investigations" },
	tabReady: false,
	needsAgent: false,
	busy: false,
	press: noop,
	rebuild: noop,
	rebuildNeedsAgent: false,
	rebuilding: false,
	reload: noop,
};
let decision: BuildBlocker = {
	kind: "decision",
	id: "cache",
	question: "expiry",
	title: "How should the cache expire?",
};
let investigations: BuildBlocker[] = [
	{ kind: "investigation", id: "startup", title: "Compare cold-start times" },
	{ kind: "investigation", id: "memory", title: "Measure cache memory usage" },
];

export function BuildBlockerAudit() {
	let [selected, setSelected] = useState("");
	return (
		<AuditPlate
			item="build-blockers"
			title="Build blockers"
			description="Production capsules and named blockers. Hover or click, then select a row."
		>
			<div className="flex flex-wrap items-center gap-3">
				{[[decision], investigations, [decision, ...investigations]].map((items, index) => (
					<BuildPlanButton
						blockers={items}
						build={build}
						canEdit
						key={index}
						onBlockerSelect={item =>
							setSelected(`${item.kind === "decision" ? "Review" : "Open"}: ${item.title}`)}
						onHover={noop}
						onOpen={noop}
					/>
				))}
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-3">
				<BuildPlanButton
					build={{
						...build,
						look: { kind: "plan", blocked: "Connect a Planner to this document to build" },
					}}
					canEdit
					documentURL="http://localhost:8787/githubnext/chopin/cache-plan"
					onHover={noop}
					onOpen={noop}
				/>
				<BuildPlanButton
					build={{
						...build,
						look: { kind: "agent", retry: true, tip: "Your local agent isn’t connected" },
					}}
					canEdit
					documentURL="http://localhost:8787/githubnext/chopin/cache-plan"
					onHover={noop}
					onOpen={noop}
				/>
			</div>
			<p className="m-0 mt-2 text-sm text-text-secondary" role="status">{selected}</p>
		</AuditPlate>
	);
}
