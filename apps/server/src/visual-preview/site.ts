import { getDomain } from "tldts";

function loopback(hostname: string) {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function previewOrigin(
	appOrigin: string,
	raw = process.env.VISUAL_PREVIEW_ORIGIN,
	credentialFree = process.env.VISUAL_PREVIEW_CREDENTIAL_FREE,
): string | undefined {
	if (!raw) return;
	let app = new URL(appOrigin);
	let preview = new URL(raw);
	if (
		preview.username || preview.password || preview.pathname !== "/"
		|| preview.search || preview.hash || !["http:", "https:"].includes(preview.protocol)
		|| app.hostname === preview.hostname
	) throw new Error("Visual preview must use a separate credential-free origin");
	if (loopback(app.hostname) && loopback(preview.hostname)) return preview.origin;
	let appSite = getDomain(app.hostname, { allowPrivateDomains: true });
	let previewSite = getDomain(preview.hostname, { allowPrivateDomains: true });
	if (
		app.protocol !== "https:" || preview.protocol !== "https:"
		|| !appSite || !previewSite || appSite === previewSite || credentialFree !== "1"
	) throw new Error("Visual preview requires HTTPS, a separate registrable site, and credential-free operator approval");
	return preview.origin;
}
