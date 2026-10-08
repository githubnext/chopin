import { useEffect, useState } from "react";

import type { NoticeOptions } from "./navigation-notice";

/** Shares the creation status surface so every transient shell message looks the same. */
export default function NavigationNotice(
	{ notice, show }: { notice: NoticeOptions; show: (options?: NoticeOptions) => void },
) {
	let [leaving, setLeaving] = useState(false);
	useEffect(() => {
		let duration = notice.duration ?? 2000;
		setLeaving(false);
		let fade = setTimeout(setLeaving, duration - 120, true);
		let timer = setTimeout(show, duration);
		return () => {
			clearTimeout(fade);
			clearTimeout(timer);
		};
	}, [notice, show]);
	return (
		<div className="navigation-creation-status" data-leaving={leaving || undefined} role="status">
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
