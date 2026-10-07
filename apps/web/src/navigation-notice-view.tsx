import { useEffect } from "react";

import type { NoticeOptions } from "./navigation-notice";

/** Shares the creation status surface so every transient shell message looks the same. */
export default function NavigationNotice(
	{ notice, show }: { notice: NoticeOptions; show: (options?: NoticeOptions) => void },
) {
	useEffect(() => {
		let timer = setTimeout(show, notice.duration ?? 2000);
		return () => clearTimeout(timer);
	}, [notice, show]);
	return (
		<div className="navigation-creation-status" role="status">
			{notice.message}
			{notice.action && (
				<button
					onClick={() => {
						notice.action?.onAction();
						show();
					}}
					type="button"
				>
					{notice.action.label}
				</button>
			)}
		</div>
	);
}
