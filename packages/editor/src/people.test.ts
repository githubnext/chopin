import { describe, expect, it } from "bun:test";

import { avatarOf, rememberAvatars, subscribeAvatars } from "./people";

describe("the pictures the server stored for real people", () => {
	it("are found by login whatever its casing, and kept once learned", () => {
		rememberAvatars([{ login: "Dana_Acme", avatarUrl: "https://avatars.test/u/1" }]);
		expect(avatarOf("dana_acme")).toBe("https://avatars.test/u/1");
		expect(avatarOf("DANA_ACME")).toBe("https://avatars.test/u/1");
		expect(avatarOf("nobody_acme")).toBeUndefined();
		// A later frame that names her without a picture does not take it away.
		rememberAvatars([{ login: "dana_acme" }, { login: "dana_acme", avatarUrl: "" }]);
		expect(avatarOf("dana_acme")).toBe("https://avatars.test/u/1");
	});

	it("are replaced when GitHub's own address for the login changes", () => {
		rememberAvatars([{ login: "rey_acme", avatarUrl: "https://avatars.test/u/2?v=1" }]);
		rememberAvatars([{ login: "rey_acme", avatarUrl: "https://avatars.test/u/2?v=2" }]);
		expect(avatarOf("rey_acme")).toBe("https://avatars.test/u/2?v=2");
	});

	it("tell a face that already drew the guess, once, and only when something was learned", () => {
		let heard = 0;
		let stop = subscribeAvatars(() => heard++);
		rememberAvatars([{ login: "kit_acme", avatarUrl: "https://avatars.test/u/3" }]);
		expect(heard).toBe(1);
		rememberAvatars([{ login: "KIT_ACME", avatarUrl: "https://avatars.test/u/3" }, {
			login: "kit_acme",
		}]);
		expect(heard).toBe(1);
		stop();
		rememberAvatars([{ login: "kit_acme", avatarUrl: "https://avatars.test/u/3?v=2" }]);
		expect(heard).toBe(1);
	});

	it("never include a demo actor, whose picture is the roster's", () => {
		rememberAvatars([{ login: "demo:lily", avatarUrl: "https://avatars.test/u/4" }]);
		expect(avatarOf("demo:lily")).toBeUndefined();
	});
});
