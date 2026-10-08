import type { Page } from "@playwright/test";

/** Record every workspace room element that enters or leaves the document. */
export async function recordRoomMounts(page: Page): Promise<{
	mounts: () => Promise<string[]>;
	reads: (id: string) => number;
}> {
	await page.addInitScript(() => {
		let log: string[] = [];
		Object.defineProperty(window, "__roomMounts", { value: log });
		let record = (nodes: NodeList, verb: string) => {
			for (let node of nodes) {
				if (!(node instanceof Element)) continue;
				for (let element of [node, ...node.querySelectorAll("[data-workspace-room]")]) {
					let id = element.getAttribute("data-workspace-room");
					if (id) log.push(`${verb} ${id}`);
				}
			}
		};
		new MutationObserver(records => {
			for (let item of records) {
				record(item.addedNodes, "mount");
				record(item.removedNodes, "unmount");
			}
		}).observe(document, { childList: true, subtree: true });
	});
	let channelReads: string[] = [];
	page.on("request", request => {
		let match = /^\/api\/channels\/([^/]+)$/.exec(new URL(request.url()).pathname);
		if (match) channelReads.push(match[1]!);
	});
	return {
		mounts: () =>
			page.evaluate(() => [...(window as unknown as { __roomMounts: string[] }).__roomMounts]),
		reads: id => channelReads.filter(value => value === id).length,
	};
}
