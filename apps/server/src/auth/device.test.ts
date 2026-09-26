import { describe, expect, it } from "bun:test";

import { DeviceAuthorization } from "./device";

function client(responses: Array<unknown | Error>) {
	let requests: Array<{ url: string; body: URLSearchParams }> = [];
	let device = new DeviceAuthorization({
		fetch: async (input, init) => {
			requests.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
			let response = responses.shift();
			if (response instanceof Error) throw response;
			return Response.json(response);
		},
	});
	return { device, requests };
}

describe("GitHub device authorization network boundary", () => {
	it("requests the public client ID without scopes and polls with the device grant", async () => {
		let { device, requests } = client([
			{
				device_code: "private",
				user_code: "TEST-1234",
				verification_uri: "https://github.com/login/device",
				expires_in: 900,
				interval: 5,
			},
			{ error: "authorization_pending" },
			{ error: "slow_down", interval: 10 },
			{
				access_token: "ghu_private",
				refresh_token: "ghr_private",
				token_type: "bearer",
				expires_in: 28_800,
				refresh_token_expires_in: 15_897_600,
			},
		]);
		let code = await device.request("client-id");
		expect(code).toMatchObject({ userCode: "TEST-1234", interval: 5 });
		expect(requests[0]!.body.toString()).toBe("client_id=client-id");
		expect(await device.poll("client-id", code.deviceCode)).toEqual({ status: "pending" });
		expect(await device.poll("client-id", code.deviceCode)).toEqual({
			status: "slow_down",
			interval: 10,
		});
		expect((await device.poll("client-id", code.deviceCode)).status).toBe("granted");
		expect(requests[1]!.body.get("grant_type"))
			.toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(requests[1]!.body.get("device_code")).toBe("private");
		expect(requests[1]!.body.has("client_secret")).toBe(false);
	});

	it("classifies denial, both expiry names, malformed replies and transient network failures", async () => {
		let { device } = client([
			{ error: "access_denied" },
			{ error: "expired_token" },
			{ error: "token_expired" },
			{ error: "device_flow_disabled" },
			{ access_token: "secret" },
			new Error("network"),
		]);
		let states = [];
		for (let index = 0; index < 6; index++) states.push((await device.poll("id", "code")).status);
		expect(states).toEqual(["denied", "expired", "expired", "failed", "failed", "transient"]);
	});
});
