import { ArchiveIcon, ChevronIcon, DocumentIcon, LoaderIcon, PlusIcon } from "@chopin/icons";

import { AuditPlate } from "../frame";

export function NavigationPlate() {
	return (
		<AuditPlate
			description="Current, ancestor, archived, and loading rows in one compact rail. Descriptions appear on hover or focus."
			item="navigation"
			title="Navigation"
		>
			<nav aria-label="Audit navigation" className="design-audit-sidebar" data-tooltip-edge="">
				<div className="design-audit-sidebar-heading">
					<span>Chopin</span>
					<button aria-label="Add document" className="btn btn-icon btn-ghost" type="button">
						<PlusIcon size={14} />
					</button>
				</div>
				<a
					aria-description="Where the collaborative editor goes next"
					data-tooltip="Where the collaborative editor goes next"
					data-tooltip-side="right"
					data-tooltip-verbatim=""
					href="#surfaces"
				>
					<DocumentIcon size={14} />Product direction
				</a>
				<a aria-current="page" href="#surfaces">
					<DocumentIcon size={14} />Design system audit
				</a>
				<a data-navigation-state="ancestor" href="#surfaces">
					<ChevronIcon size={14} />Research notes
				</a>
				<a data-navigation-state="archived" href="#surfaces">
					<ArchiveIcon size={14} />Archived draft
				</a>
				<div className="design-audit-navigation-loading">
					<LoaderIcon size={14} />Loading more…
				</div>
			</nav>
			<nav
				aria-label="Compact workspace view"
				className="workspace-navigation design-audit-compact-navigation"
			>
				<button className="btn btn-md btn-ghost min-h-11" type="button">Conversation</button>
				<button className="btn btn-md btn-ghost min-h-11" type="button">Document</button>
				<button aria-current="page" className="btn btn-md btn-ghost min-h-11" type="button">
					Decisions
				</button>
				<button className="btn btn-md btn-ghost min-h-11" type="button">Background</button>
			</nav>
		</AuditPlate>
	);
}
