import { AI_PROXY_PATH } from "@chopin/protocol/ai-credentials";

import type { Server } from "bun";

const MIN_IDLE_TIMEOUT_SECONDS = 60;
const MAX_IDLE_TIMEOUT_SECONDS = 255;
const HANDOVER_IDLE_MARGIN_SECONDS = 10;

const UNLIMITED_EXACT_PATHS = new Set(["/mcp", "/connector/mcp"]);
const AI_PROXY_PREFIX = `${AI_PROXY_PATH}/`;

export function serverIdleTimeoutSeconds(holdMs: number): number {
	let handoverSeconds = Math.ceil(Math.max(0, holdMs) / 1_000) + HANDOVER_IDLE_MARGIN_SECONDS;
	return Math.min(MAX_IDLE_TIMEOUT_SECONDS, Math.max(MIN_IDLE_TIMEOUT_SECONDS, handoverSeconds));
}

export function isUnlimitedTimeoutPath(pathname: string): boolean {
	return pathname.startsWith(AI_PROXY_PREFIX) || UNLIMITED_EXACT_PATHS.has(pathname);
}

export function applyRequestTimeout(
	request: Request,
	server: Pick<Server<unknown>, "timeout">,
): void {
	let pathname: string;
	try {
		pathname = new URL(request.url).pathname;
	} catch {
		return;
	}
	if (isUnlimitedTimeoutPath(pathname)) server.timeout(request, 0);
}
