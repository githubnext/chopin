import { useEffect, useState } from "react";

import type { NoticeOptions } from "./navigation-notice";

/** Shares the creation status surface so every transient shell message looks the same. */
export default function NavigationNotice(
	{ notice, show }: { notice: NoticeOptions; show: (options?: NoticeOptions) => void },
) {
	let [leaving, setLeaving] = useState(false);
	let [held, setHeld] = useState(false);
	let actionable = !!notice.action;
	useEffect(() => {
		if (held) return;
		let duration = notice.duration ?? 2000;
		setLeaving(false);
		let fade = setTimeout(setLeaving, duration - 120, true);
		let timer = setTimeout(show, duration);
		return () => {
			clearTimeout(fade);
			clearTimeout(timer);
		};
	}, [held, notice, show]);
	return (
		<div
			className={actionable
				? "navigation-creation-status navigation-notice"
				: "navigation-creation-status"}
			data-leaving={leaving || undefined}
			onBlur={actionable
				? event => {
					if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
				}
				: undefined}
			onFocus={actionable ? () => setHeld(true) : undefined}
			onMouseEnter={actionable ? () => setHeld(true) : undefined}
			onMouseLeave={actionable ? () => setHeld(false) : undefined}
			role="status"
		>
			<span>{notice.message}</span>
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
