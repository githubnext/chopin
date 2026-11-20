import { BuildCard } from "../../chat/run-card";
import { AuditPlate, StateLabel } from "../frame";

import type { BuildRun } from "../../build-model";

/** Placed just before now, so the build's age reads as minutes. */
const STARTED = new Date(Date.now() - 6 * 60_000).toISOString();

const BUILDING: BuildRun = {
	id: "audit-build",
	kind: "build",
	state: "building",
	done: 1,
	total: 3,
	task: "Prove the contract",
	activity: "Running the verifier",
	started: STARTED,
	pullRequests: ["https://github.com/octo-org/score/pull/12"],
};

export function RunningBuildPlate() {
	return (
		<AuditPlate
			description="The document's running build, under Chat's transcript while it runs: its task, its agent's latest activity and the pull requests it has opened, and a rebuild waiting to start."
			item="running-build"
			title="Running build"
		>
			<div className="flex flex-col gap-2">
				<StateLabel>Building</StateLabel>
				<BuildCard build={BUILDING} onShowBuild={() => {}} />
				<StateLabel>Queued</StateLabel>
				<BuildCard
					build={{
						...BUILDING,
						id: "audit-rebuild",
						kind: "rebuild",
						state: "queued",
						task: undefined,
						activity: undefined,
						pullRequests: [],
					}}
				/>
			</div>
		</AuditPlate>
	);
}
