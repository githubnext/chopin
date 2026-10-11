import type { NoticeOptions } from "./navigation-notice";

/**
 * Reports a clipboard write. The caller starts the write itself, inside the tap or click,
 * because iOS Safari refuses one that begins after an asynchronous module load.
 */
export async function copyLink(written: Promise<void>, notify: (notice: NoticeOptions) => void) {
	try {
		await written;
		notify({ message: "Link copied" });
	} catch {
		notify({ message: "Could not copy link" });
	}
}
