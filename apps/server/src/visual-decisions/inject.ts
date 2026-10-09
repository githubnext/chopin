import type { Plan } from "../plan/service";
import { create } from "./create";

/** Real document persistence with fixture artifacts, enabled only in the E2E server. */
export async function seed(plan: Plan): Promise<void> {
	if (process.env.E2E_VISUAL_DECISIONS !== "1" || process.env.NODE_ENV === "production") return;
	let fixtures = await import("../../../../e2e/visual-decision-fixtures/fixtures");
	for (let definition of await fixtures.fixtureVisualDefinitions()) {
		await create(plan, definition, fixtures.verifyFixtureArtifact);
	}
}
