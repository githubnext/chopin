import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DecisionCard } from "./decision";

describe("DecisionCard", () => {
	it("renders an accepted thread as a frozen decision", () => {
		let markup = renderToStaticMarkup(
			<DecisionCard
				value={{
					id: "decision-1",
					quote: "Keep the rollout reversible.",
					by: "ana",
					at: "2026-08-12T10:30:00.000Z",
					notes: [
						{ by: "ana", text: "Use a feature flag." },
						{ by: "bo", text: "Measure rollback time." },
					],
				}}
			/>,
		);

		expect(markup).toContain('article aria-label="Decision"');
		expect(markup).toContain("Keep the rollout reversible.");
		expect(markup).toContain("@ana");
		expect(markup).toContain("Use a feature flag.");
		expect(markup).toContain("@bo");
		expect(markup).toContain("Measure rollback time.");
		expect(markup).toContain('Accepted by <span class="text-brand-ink">@ana</span>');
		expect(markup).toContain('class="text-sm font-semibold text-brand-ink"');
		expect(markup).toContain("data-plan-comment-context");
		expect(markup.indexOf("Use a feature flag.")).toBeLessThan(
			markup.indexOf("Keep the rollout reversible."),
		);
		expect(markup).not.toContain("italic");
	});
});
