import { Count } from "@chopin/editor";
import { MachineIcon } from "@chopin/icons";

import { machinesLabel, useMachineSummary } from "./machine-summary";

/**
 * The navigation's way to the person's machines and their setup at /connect: how many are paired,
 * and a dot while any is connected. Its accessible name says the same in words.
 */
export function MachinesEntry({ placement }: { placement: "sidebar" | "sheet" }) {
	let summary = useMachineSummary();
	return (
		<a
			aria-label={machinesLabel(summary)}
			className={placement === "sheet" ? "documents-sheet-link" : "project-sidebar-primary-action"}
			href="/connect"
		>
			<MachineIcon aria-hidden="true" className="machines-entry-icon" />
			<span className="truncate">Machines</span>
			{!!summary?.paired && (
				<span aria-hidden="true" className="machines-entry-count">
					{summary.connected > 0 && <span className="machines-connected-dot" />}
					<Count appearance="quiet" typography="metadata">{summary.paired}</Count>
				</span>
			)}
		</a>
	);
}
