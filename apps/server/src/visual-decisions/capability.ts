import type { TrustedPreviewResolver } from "../visual-preview/descriptor";
import type { Source } from "./requests";

/** Installed fulfillment owns request delivery, verified decision publication, and artifact reads. */
export type VisualPreviewCapability = {
	/** Persist the request and arrange its fulfillment before reporting it as pending. */
	request: (
		source: Source,
		stillCurrent: () => boolean,
	) => Promise<{ requestId: string; state: "pending" }>;
	publish: (requestId: string) => Promise<void>;
	resolve: TrustedPreviewResolver;
};

export function availableVisualPreview(value: unknown): value is VisualPreviewCapability {
	if (!value || typeof value !== "object") return false;
	let provider = value as Partial<VisualPreviewCapability>;
	return typeof provider.request === "function"
		&& typeof provider.publish === "function"
		&& typeof provider.resolve === "function";
}
