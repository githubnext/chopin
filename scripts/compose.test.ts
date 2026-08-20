import { describe, expect, it } from "bun:test";

const PREVIEW_CONFIGURATION = [
	"AGENT",
	"APP_ORIGIN",
	"GITHUB_APP_SLUG",
	"GITHUB_APP_CLIENT_ID",
	"GITHUB_APP_CLIENT_SECRET",
	"GITHUB_ALLOWED_USERS",
	"GITHUB_ALLOWED_ORGANIZATIONS",
	"MODEL",
	"SESSION_ENCRYPTION_KEY",
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
});
