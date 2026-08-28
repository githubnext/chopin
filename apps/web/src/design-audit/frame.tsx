import { useState } from "react";

import type { ReactNode } from "react";
import type { AuditGroup } from "./inventory";

export function AuditFrame(
	{ children, groups }: { children: ReactNode; groups: readonly AuditGroup[] },
) {
	let [width, setWidth] = useState<"wide" | "narrow">("wide");
	return (
		<main className="design-audit" data-design-audit="">
			<header className="design-audit-header">
				<div>
					<h1>Chopin design audit</h1>
					<p>
						A live map of the foundations, controls, surfaces, and authored content in the
						application.
					</p>
				</div>
				<div aria-label="Preview width" className="design-audit-width-controls" role="group">
					<button
						aria-label="Preview wide layout"
						aria-pressed={width === "wide"}
						className="btn btn-sm btn-ghost"
						onClick={() => setWidth("wide")}
						type="button"
					>
						Wide
					</button>
					<button
						aria-label="Preview narrow layout"
						aria-pressed={width === "narrow"}
						className="btn btn-sm btn-ghost"
						onClick={() => setWidth("narrow")}
						type="button"
					>
						Narrow
					</button>
				</div>
			</header>
			<div className="design-audit-layout">
				<nav aria-label="Design audit sections" className="design-audit-nav">
					{groups.map(group => <a href={`#${group.id}`} key={group.id}>{group.label}</a>)}
				</nav>
				<div className="design-audit-preview" data-preview-width={width}>{children}</div>
			</div>
		</main>
	);
}

export function AuditSection(
	{ children, id, title }: { children: ReactNode; id: string; title: string },
) {
	return (
		<section className="design-audit-section" id={id}>
			<h2>{title}</h2>
			{children}
		</section>
	);
}

export function AuditPlate(
	{ children, description, title }: { children?: ReactNode; description?: string; title: string },
) {
	return (
		<section className="design-audit-plate">
			<header>
				<h3>{title}</h3>
				{description ? <p>{description}</p> : null}
			</header>
			<div className="design-audit-specimen">{children}</div>
		</section>
	);
}

export function StateLabel({ children }: { children: ReactNode }) {
	return <span className="design-audit-state">{children}</span>;
}
