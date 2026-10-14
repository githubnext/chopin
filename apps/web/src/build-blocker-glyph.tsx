import { DecisionIcon, InvestigationIcon } from "@chopin/icons";
import type { BuildBlocker } from "./build-blockers";

export function BuildBlockerGlyph({ tone }: { tone: BuildBlocker["kind"] | "mixed" }) {
	return (
		<span className="build-blocker-glyphs" aria-hidden="true">
			{tone !== "investigation" && <DecisionIcon className="build-blocker-decision" />}
			{tone !== "decision" && <InvestigationIcon className="build-blocker-investigation" />}
		</span>
	);
}
