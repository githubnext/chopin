import { describe, expect, it } from "bun:test";

import { isDesignAuditRoute } from "./route";

describe("design audit route", () => {
	it("exists only in development at its exact path", () => {
		expect(isDesignAuditRoute("/design-audit", true)).toBe(true);
		expect(isDesignAuditRoute("/design-audit", false)).toBe(false);
		expect(isDesignAuditRoute("/design-audit/extra", true)).toBe(false);
	});
});
