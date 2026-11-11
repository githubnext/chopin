import { clampPane } from "../../resizable-pane";
import { workspaceSizing } from "../../workspace-sizing";

import type { WorkspaceMode } from "../../workspace-model";

export const CHAT_MIN_WITH_THREAD = 420;
export const THREAD_MIN = 360;
export const THREAD_MAX = 560;
export const THREAD_RATIO = 0.4;
export const DOC_MIN_WITH_THREAD = 480;
export const THREE_PANE_MIN = CHAT_MIN_WITH_THREAD + THREAD_MIN + DOC_MIN_WITH_THREAD;
export const THREAD_PANE_STORAGE_KEY = "chopin:pane:thread";

export type ThreadSplitResult = {
	mode: WorkspaceMode;
	/** Combined width of `.workspace-chat-panel` (Chat + Thread when a thread is open). */
	combined: number;
	/** Width of the main Chat column inside `.workspace-chat-panel`. */
	chat: number;
	/** Width of the Thread column inside `.workspace-chat-panel` (0 when closed or compact/phone). */
	thread: number;
	/** Maximum width the outer `Resize chat` handle allows. */
	maximumCombined: number;
	/** Maximum width the inner `Resize thread` handle allows. */
	maximumThread: number;
	/** True when the window cannot fit Chat (420) + Thread (360) + Document (480) at once. */
	documentCollapsed: boolean;
};

/**
 * Slack's balanced split:
 * - Thread opens at ~40% of combined Chat+Thread width (min 360px, max 560px).
 * - Chat keeps the rest (min 420px).
 * - Document gives up its width first down to 480px, then collapses to its header and tab when
 *   `available < 1260` (`420 + 360 + 480`).
 */
export function threadSplitSizing(input: {
	available: number;
	preferredChat: number;
	preferredThread?: number;
	threadOpen: boolean;
}): ThreadSplitResult {
	let { available, preferredChat, preferredThread, threadOpen } = input;
	if (!threadOpen) {
		let base = workspaceSizing(available, preferredChat);
		return {
			mode: base.mode,
			combined: base.chat,
			chat: base.chat,
			thread: 0,
			maximumCombined: base.maximum,
			maximumThread: THREAD_MAX,
			documentCollapsed: false,
		};
	}

	let mode: WorkspaceMode = available < 700 ? "compact" : "split";
	if (mode === "compact") {
		return {
			mode,
			combined: available,
			chat: available,
			thread: 0,
			maximumCombined: available,
			maximumThread: THREAD_MAX,
			documentCollapsed: false,
		};
	}

	let combinedMin = CHAT_MIN_WITH_THREAD + THREAD_MIN;
	if (available < THREE_PANE_MIN) {
		let combined = Math.max(combinedMin, available);
		let maxThread = Math.max(THREAD_MIN, Math.min(THREAD_MAX, combined - CHAT_MIN_WITH_THREAD));
		let targetThread = preferredThread ?? Math.round(combined * THREAD_RATIO);
		let thread = clampPane(targetThread, THREAD_MIN, maxThread);
		let chat = Math.max(250, combined - thread);
		return {
			mode: "split",
			combined: available,
			chat: Math.min(available - THREAD_MIN, chat),
			thread: available >= combinedMin
				? thread
				: Math.min(THREAD_MIN, Math.floor(available * 0.45)),
			maximumCombined: available,
			maximumThread: maxThread,
			documentCollapsed: true,
		};
	}

	let maxCombined = available - DOC_MIN_WITH_THREAD;
	let desiredChat = Math.max(CHAT_MIN_WITH_THREAD, preferredChat);
	let desiredCombined = preferredThread !== undefined
		? desiredChat + preferredThread
		: Math.max(desiredChat + THREAD_MIN, Math.round(desiredChat / (1 - THREAD_RATIO)));
	let combined = clampPane(desiredCombined, combinedMin, maxCombined);
	let maxThread = Math.max(THREAD_MIN, Math.min(THREAD_MAX, combined - CHAT_MIN_WITH_THREAD));
	let targetThread = preferredThread ?? Math.round(combined * THREAD_RATIO);
	let thread = clampPane(targetThread, THREAD_MIN, maxThread);
	let chat = combined - thread;
	return {
		mode: "split",
		combined,
		chat,
		thread,
		maximumCombined: maxCombined,
		maximumThread: Math.min(THREAD_MAX, maxCombined - CHAT_MIN_WITH_THREAD),
		documentCollapsed: false,
	};
}
