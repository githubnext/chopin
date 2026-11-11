import {
	type AttachmentLimits,
	attachmentName,
	type AttachmentRefusal,
	checkAttachment,
	refusalText,
} from "@chopin/protocol/attachment";

import { ownOrigin } from "../auth/config";
import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";
import { StorageError } from "../storage/errors";
import { wireAttachment } from "./wire";

import type { HostedAuth } from "../auth/routes";
import type { AuthenticatedSession } from "../auth/session";
import type { Router } from "../http/router";
import type { ChannelRecord } from "../storage/model";

/** Uploads one person may leave unsent in a document, as a multiple of what a message may carry. */
const STAGED_FACTOR = 4;
/** How long an upload nobody sent is kept. */
const STAGED_KEPT_MS = 24 * 60 * 60 * 1000;

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
	});
}

function plain(status: number, message: string): Response {
	return new Response(message, {
		status,
		headers: {
			"cache-control": "no-store",
			"content-type": "text/plain; charset=utf-8",
			"x-content-type-options": "nosniff",
		},
	});
}

function refused(reason: AttachmentRefusal, status: number, limits: AttachmentLimits): Response {
	return json({ error: refusalText(reason, { limits }), reason }, status);
}

/**
 * The document a request may read or write in. Every refusal of a read is the same 404, so a URL
 * reveals nothing to anyone who cannot read the document.
 */
async function openDocument(
	auth: HostedAuth,
	session: AuthenticatedSession,
	channelId: string,
): Promise<{ channel: ChannelRecord; canWrite: boolean } | undefined> {
	if (!isChannelId(channelId)) return undefined;
	let channel = await auth.storage.channels.get(channelId);
	if (!channel) return undefined;
	let { value: repository } = await auth.sessions.use(
		session,
		token => auth.github.repositoryAccess(token, channel.repositoryOwner, channel.repositoryName),
	);
	if (repository?.id !== channel.repositoryId || !repository.permissions.pull) return undefined;
	return {
		channel,
		canWrite: (repository.permissions.push || repository.permissions.admin) && !channel.archivedAt,
	};
}

/** The request's body, or undefined as soon as it is more than `limit` bytes. */
async function boundedBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
	let declared = request.headers.get("content-length");
	if (declared !== null && Number(declared) > limit) return undefined;
	if (!request.body) return new Uint8Array();
	let chunks: Uint8Array[] = [];
	let total = 0;
	let reader = request.body.getReader();
	while (true) {
		let { done, value } = await reader.read();
		if (done || !value) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	let body = new Uint8Array(total);
	let offset = 0;
	for (let chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

/** `filename*` carries the name as UTF-8, so no character of it can end the header. */
function disposition(kind: "inline" | "attachment", name: string): string {
	let ascii = name.replace(/[^\x20-\x7e]|["\\;]/g, "_");
	return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Upload, serve and take back the images and text files of Chat messages. A file is read only
 * by people who can read the document, as a safe type that is never HTML or SVG: a raster image
 * is shown, and text is a download.
 *
 * `limits` is absent where the server takes no files, and every route then answers 404.
 */
export function registerAttachmentRoutes(
	router: Router,
	auth: HostedAuth,
	options: { limits: AttachmentLimits | undefined; id?: () => string },
): void {
	let { limits } = options;

	router.on("POST", "/api/channels/:channelId/attachments", async (request, url, params) => {
		if (!limits) return json({ error: "files are not accepted here" }, 404);
		if (!ownOrigin(auth.config, request.headers.get("origin"))) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let opened = await openDocument(auth, session, params.channelId!);
			if (!opened) return json({ error: "document not found" }, 404);
			if (!opened.canWrite) return refused("not-allowed", 403, limits);
			let bytes = await boundedBody(request, limits.maxBytes);
			if (!bytes) return refused("too-large", 413, limits);
			let name = attachmentName(
				url.searchParams.get("name") ?? "",
				"file",
			);
			let checked = checkAttachment(
				{ name, type: url.searchParams.get("type") ?? undefined, bytes },
				limits,
			);
			if (!checked.ok) {
				return json({
					error: refusalText(checked.reason, { name, limits }),
					reason: checked.reason,
				}, checked.reason === "too-large" ? 413 : 422);
			}
			let channelId = opened.channel.id;
			let userId = session.user.id;
			let { storage } = auth;
			let now = auth.clock();
			void storage.chatAttachments.prune(new Date(now.getTime() - STAGED_KEPT_MS)).catch(() => {});
			let staged = await storage.chatAttachments.staged(channelId, userId);
			if (staged.count >= limits.maxCount * STAGED_FACTOR) {
				return refused("too-many", 429, limits);
			}
			if (staged.bytes + bytes.byteLength > limits.maxTotalBytes * STAGED_FACTOR) {
				return refused("too-much", 429, limits);
			}
			let attachment = {
				id: options.id?.() ?? crypto.randomUUID(),
				channelId,
				name: attachmentName(name, checked.kind),
				kind: checked.kind,
				mimeType: checked.mimeType,
				bytes,
				uploadedBy: userId,
				now,
			};
			await storage.chatAttachments.put(attachment);
			return json({
				attachment: wireAttachment({ ...attachment, size: bytes.byteLength }),
			}, 201);
		} catch (err) {
			return failed(err, auth);
		}
	});

	router.on("GET", "/api/channels/:channelId/attachments/:id", async (request, _url, params) => {
		let missing = plain(404, "file not found");
		if (!limits) return missing;
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return missing;
			let opened = await openDocument(auth, session, params.channelId!);
			if (!opened) return missing;
			let found = await auth.storage.chatAttachments.get(opened.channel.id, params.id!);
			// Until it is sent with a message a file is its uploader's alone.
			if (!found || (found.entryId === undefined && found.uploadedBy !== session.user.id)) {
				return missing;
			}
			let image = found.kind === "image";
			return new Response(found.bytes.slice(), {
				headers: {
					"cache-control": "private, max-age=31536000, immutable",
					"content-disposition": disposition(image ? "inline" : "attachment", found.name),
					"content-security-policy": "default-src 'none'; sandbox",
					"content-type": image ? found.mimeType : "text/plain; charset=utf-8",
					"cross-origin-resource-policy": "same-origin",
					"x-content-type-options": "nosniff",
				},
			});
		} catch (err) {
			return err instanceof GitHubError && err.status === 401
				? missing
				: plain(503, "file is temporarily unavailable");
		}
	});

	router.on("DELETE", "/api/channels/:channelId/attachments/:id", async (request, _url, params) => {
		if (!limits) return json({ error: "files are not accepted here" }, 404);
		if (!ownOrigin(auth.config, request.headers.get("origin"))) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			let opened = await openDocument(auth, session, params.channelId!);
			if (!opened) return json({ error: "document not found" }, 404);
			let removed = await auth.storage.chatAttachments.discard(
				opened.channel.id,
				params.id!,
				session.user.id,
			);
			return removed ? new Response(null, { status: 204 }) : json({ error: "file not found" }, 404);
		} catch (err) {
			return failed(err, auth);
		}
	});
}

function failed(err: unknown, auth: HostedAuth): Response {
	if (err instanceof GitHubError) {
		if (err.status === 401) {
			return new Response(JSON.stringify({ error: "GitHub authorization expired" }), {
				status: 401,
				headers: {
					"cache-control": "no-store",
					"content-type": "application/json; charset=utf-8",
					"set-cookie": auth.sessions.clearCookie(),
				},
			});
		}
		return json({ error: "document access could not be checked" }, 503);
	}
	if (err instanceof StorageError && err.failure === "missing") {
		return json({ error: "document not found" }, 404);
	}
	console.error("[attachments] request failed:", err);
	return json({ error: "the file could not be handled" }, 503);
}
