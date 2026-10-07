import { response } from "./api";

export type DeviceAuthorizationStatus =
	| { status: "waiting"; userCode: string; verificationUri: string; expiresAt: string }
	| { status: "authorized" }
	| { status: "consent"; path: string }
	| { status: "complete" }
	| { status: "failed"; message: string }
	| { status: "expired" }
	| { status: "denied" }
	| { status: "cancelled" };

/**
 * Local device-flow sign-in routes (`AUTH_MODE=local` only). Cookie
 * credentials must travel with each request so the server can bind the
 * attempt to the initiating browser; the server never answers these with a
 * generic 401, so a failure here does not trigger the reload in `decoded()`.
 */
export function startDeviceAuthorization(): Promise<DeviceAuthorizationStatus> {
	return response("/auth/device", { method: "POST", credentials: "same-origin" });
}

export function deviceAuthorizationStatus(): Promise<DeviceAuthorizationStatus> {
	return response("/auth/device", { credentials: "same-origin" });
}

export function completeDeviceAuthorization(): Promise<DeviceAuthorizationStatus> {
	return response("/auth/device/complete", { method: "POST", credentials: "same-origin" });
}

export function consentDeviceAuthorization(accept: boolean): Promise<DeviceAuthorizationStatus> {
	return response("/auth/device/consent", {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ accept }),
	});
}

export function cancelDeviceAuthorization(): Promise<void> {
	return response("/auth/device/cancel", { method: "POST", credentials: "same-origin" });
}
