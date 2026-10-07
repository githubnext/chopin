import type { NoticeOptions } from "./navigation-notice";

export async function copyLink(href: string, notify: (notice: NoticeOptions) => void) {
	try {
		await navigator.clipboard.writeText(href);
		notify({ message: "Link copied" });
	} catch {
		notify({ message: "Could not copy link" });
	}
}
