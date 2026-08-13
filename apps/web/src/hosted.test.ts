import { describe, expect, it } from "bun:test";

import { hostedRoute } from "./hosted";

describe("hosted routes", () => {
	it("recognizes repositories and channels without rewriting legacy paths", () => {
		expect(hostedRoute("/")).toEqual({ page: "repositories" });
		expect(hostedRoute("/repositories/octo-org/score")).toEqual({
			page: "repository",
			owner: "octo-org",
			repository: "score",
		});
		expect(hostedRoute("/repositories/github%20next/chopin")).toEqual({
			page: "repository",
			owner: "github next",
			repository: "chopin",
		});
		expect(hostedRoute("/channels/019c1234-1234-4123-8123-123456789abc")).toEqual({
			page: "channel",
			id: "019c1234-1234-4123-8123-123456789abc",
		});
		expect(hostedRoute("/r/main")).toEqual({ page: "missing" });
	});
});
