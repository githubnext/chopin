import { describe, expect, it } from "bun:test";

const PREVIEW_CONFIGURATION = [
	"AGENT",
	"BACKGROUND_JOBS",
	"CONVERSATION_PLAN",
	"PLANNER_VISUALS",
	"DECISIONS_MODEL",
	"OPENAI_API_KEY",
	"JEV_API_KEY",
	"APP_ORIGIN",
	"PREVIOUS_ORIGINS",
	"GITHUB_APP_SLUG",
	"GITHUB_APP_CLIENT_ID",
	"GITHUB_APP_CLIENT_SECRET",
	"GITHUB_ALLOWED_USERS",
	"GITHUB_ALLOWED_ORGANIZATIONS",
	"MODEL",
	"SESSION_ENCRYPTION_KEY",
	"WEB_RESEARCH",
] as const;

describe("deployment compose", () => {
	it("leaves preview configuration for Coolify's runtime environment", async () => {
		let source = await Bun.file(new URL("../compose.yaml", import.meta.url)).text();
		let compose = Bun.YAML.parse(source) as {
			services?: { app?: { environment?: Record<string, unknown> } };
		};
		let environment = compose.services?.app?.environment;

		expect(environment).toBeDefined();
		for (let name of PREVIEW_CONFIGURATION) {
			expect(environment?.[name]).toBe(`\${${name}}`);
		}
		expect(environment).toMatchObject({
			DATABASE_URL: "postgresql://chopin:chopin@${SERVICE_NAME_DB:-db}:5432/chopin?sslmode=disable",
			SERVICE_URL_APP_8787: null,
			STORAGE_DRIVER: "postgres",
		});
	});

	it("gives a stopping process time to hand over, and builds with the image that runs now", async () => {
		let source = await Bun.file(new URL("../compose.yaml", import.meta.url)).text();
		let compose = Bun.YAML.parse(source) as {
			services?: {
				app?: { stop_grace_period?: string; build?: { args?: Record<string, string> } };
			};
		};
		// Longer than the turn wait, unready window, request wait and commit of a hand-over.
		expect(compose.services?.app?.stop_grace_period).toBe("30s");
		expect(compose.services?.app?.build?.args).toEqual({
			PREVIOUS_IMAGE: "${PREVIOUS_IMAGE:-no-previous}",
		});
		let dockerfile = await Bun.file(new URL("../Dockerfile", import.meta.url)).text();
		expect(dockerfile).toContain("ARG PREVIOUS_IMAGE=no-previous");
		expect(dockerfile).toContain("AS no-previous");
	});
});
