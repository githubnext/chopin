import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DecisionCard } from "./decision";

describe("DecisionCard", () => {
	let value = {
		id: "decision-1",
		quote: "Keep the rollout reversible.",
		by: "ana",
		at: "2026-08-12T10:30:00.000Z",
		notes: [
			{ by: "ana", text: "Use a feature flag." },
			{ by: "bo", text: "Measure rollback time." },
		],
	};

	it("renders an accepted thread as a collapsed row that leads with the outcome", () => {
		let markup = renderToStaticMarkup(<DecisionCard value={value} />);

		expect(markup).toContain('article aria-label="Accepted comment"');
		expect(markup).toContain("Measure rollback time.");
		expect(markup).not.toContain("Keep the rollout reversible.");
		expect(markup).toContain('aria-expanded="false"');
		expect(markup).toContain("@ana");
		expect(markup).not.toContain("Use a feature flag.");
	});

	it("shows the quote before the notes when open", () => {
		let markup = renderToStaticMarkup(
			<DecisionCard defaultOpen value={value} />,
		);

		expect(markup).toContain('aria-expanded="true"');
		expect(markup.indexOf("Keep the rollout reversible.")).toBeGreaterThan(-1);
		expect(markup.indexOf("Keep the rollout reversible.")).toBeLessThan(
			markup.indexOf("Use a feature flag."),
		);
		expect(markup).toContain("@bo");
	});
});
