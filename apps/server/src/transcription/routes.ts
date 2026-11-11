import { ownOrigin } from "../auth/config";
import { isChannelId } from "../channels/id";
import { GitHubError } from "../github/client";
import { sniffAudio } from "./audio";

import type { HostedAuth } from "../auth/routes";
import type { Router } from "../http/router";
import type { Transcriber } from "./openai";

function json(value: unknown, status = 200): Response {
	return Response.json(value, {
		status,
		headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
	});
}

/** The request's body, or undefined as soon as it is more than `limit` bytes. */
async function bounded(request: Request, limit: number): Promise<Uint8Array | undefined> {
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

/**
 * Turns a recording into words for a person writing in a document, where the deployment named a
 * transcription model. Without one there is no route at all: no audio is ever accepted, or sent
 * anywhere, unless an operator asked for it. The route is for a person who can write to the document
 * (the same as sending a message), takes only the app's own origin, and reads only what its bytes
 * show to be audio, up to `maxBytes`.
 */
export function registerTranscriptionRoutes(
	router: Router,
	auth: HostedAuth,
	options: { maxBytes: number; transcribe: Transcriber } | undefined,
): void {
	router.on("POST", "/api/channels/:channelId/transcriptions", async (request, _url, params) => {
		if (!options) return json({ error: "transcription is not set up here" }, 404);
		if (!ownOrigin(auth.config, request.headers.get("origin"))) {
			return json({ error: "origin is not allowed" }, 403);
		}
		try {
			let session = await auth.sessions.authenticate(request);
			if (!session) return json({ error: "authentication required" }, 401);
			if (!isChannelId(params.channelId!)) return json({ error: "document not found" }, 404);
			let channel = await auth.storage.channels.get(params.channelId!);
			if (!channel) return json({ error: "document not found" }, 404);
			let { value: repository } = await auth.sessions.use(
				session,
				token =>
					auth.github.repositoryAccess(token, channel.repositoryOwner, channel.repositoryName),
			);
			if (repository?.id !== channel.repositoryId || !repository.permissions.pull) {
				return json({ error: "document not found" }, 404);
			}
			if (!(repository.permissions.push || repository.permissions.admin) || channel.archivedAt) {
				return json({ error: "you can't write to this document" }, 403);
			}
			let bytes = await bounded(request, options.maxBytes);
			if (!bytes) return json({ error: "that recording is too long" }, 413);
			let type = sniffAudio(bytes);
			if (!type) return json({ error: "that is not a recording" }, 422);
			try {
				return json({ text: (await options.transcribe({ bytes, type }, request.signal)).trim() });
			} catch (error) {
				console.error("[transcription] the provider failed:", error);
				return json({ error: "the recording could not be transcribed" }, 502);
			}
		} catch (error) {
			if (error instanceof GitHubError && error.status === 401) {
				return json({ error: "GitHub authorization expired" }, 401);
			}
			console.error("[transcription] request failed:", error);
			return json({ error: "transcription is temporarily unavailable" }, 503);
		}
	});
}
