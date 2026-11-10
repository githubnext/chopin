import { expect, test } from "bun:test";

import { ApiError } from "./api";
import { unreached } from "./navigation-failure";

test("a request that never reached the server is the connection's fact", () => {
	expect(unreached({ reason: new TypeError("Failed to fetch"), retry: "refresh" })).toBe(true);
	expect(unreached({ reason: new TypeError("NetworkError when attempting to fetch resource.") }))
		.toBe(true);
});

test("an error the server answered, or the page raised, is not the connection's to tell", () => {
	expect(unreached({ reason: new ApiError("not allowed", 403), retry: "refresh" })).toBe(false);
	expect(unreached({ reason: new Error("Failed to fetch") })).toBe(false);
	expect(unreached({ reason: "nope" })).toBe(false);
});
