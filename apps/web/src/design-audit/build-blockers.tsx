import { useState } from "react";
import { CONNECT_MACHINE_TO_BUILD } from "../build-model";
import { BuildPlanButton } from "../build-plan-button";
import { AuditPlate } from "./frame";

import type { BuildPlan } from "../build-plan-button";
import type { BuildBlocker } from "../build-blockers";

let noop = () => {};
let build: BuildPlan = {
	look: { kind: "plan", blocked: "Waiting on investigations" },
	tabReady: false,
	needsAgent: false,
	busy: false,
	press: noop,
	rebuild: noop,
	rebuildNeedsAgent: false,
	rebuilding: false,
	reload: noop,
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
				{[investigations.slice(0, 1), investigations].map((items, index) => (
					<BuildPlanButton
						blockers={items}
						build={build}
						canEdit
						key={index}
						onBlockerSelect={item => setSelected(`Open: ${item.title}`)}
						onHover={noop}
						onOpen={noop}
					/>
				))}
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-3">
				<BuildPlanButton
					build={{
						...build,
						look: { kind: "plan", blocked: CONNECT_MACHINE_TO_BUILD },
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
