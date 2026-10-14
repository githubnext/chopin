import { Count } from "@chopin/editor/count";
import { MachineIcon } from "@chopin/icons";

import { machinesLabel, useMachineSummary } from "./machine-summary";

/**
 * The navigation's way to the person's machines and their setup at /connect: how many are
 * connected out of those paired, with a dot while any is connected. Its accessible name says the
 * same in words, and it is the current page while /connect is open.
 */
export function MachinesEntry(
	{ current = false, placement }: { current?: boolean; placement: "sidebar" | "sheet" },
) {
	let summary = useMachineSummary();
	return (
		<a
			aria-current={current ? "page" : undefined}
			aria-label={machinesLabel(summary)}
			className={placement === "sheet" ? "documents-sheet-link" : "project-sidebar-primary-action"}
			href="/connect"
		>
			<MachineIcon aria-hidden="true" className="machines-entry-icon" />
			<span className="truncate">Machines</span>
			{!!summary?.paired && (
				<span aria-hidden="true" className="machines-entry-count">
					{summary.connected > 0 && <span className="status-dot" data-state="connected" />}
					<Count appearance="quiet" typography="metadata">
						{summary.connected}/{summary.paired}
					</Count>
				</span>
			)}
		</a>
	);
}
