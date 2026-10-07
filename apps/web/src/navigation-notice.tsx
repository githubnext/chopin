import { useCallback, useEffect, useRef, useState } from "react";

export type NoticeOptions = {
	message: string;
	action?: { label: string; onAction: () => void };
	/** Milliseconds before the notice clears; defaults to 2000. */
	duration?: number;
};

export function useNavigationNotice() {
	let [notice, setNotice] = useState<NoticeOptions>();
	let timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	let dismiss = useCallback(() => {
		clearTimeout(timer.current);
		setNotice(undefined);
	}, []);
	let show = useCallback((options: NoticeOptions) => {
		clearTimeout(timer.current);
		setNotice(options);
		timer.current = setTimeout(() => setNotice(undefined), options.duration ?? 2000);
	}, []);
	useEffect(() => () => clearTimeout(timer.current), []);
	return { dismiss, notice, show };
}

/** Shares the creation status surface so every transient shell message looks the same. */
export function NavigationNotice(
	{ notice, onDismiss }: { notice?: NoticeOptions; onDismiss: () => void },
) {
	if (!notice) return null;
	return (
		<div className="navigation-creation-status" role="status">
			<p>
				{notice.message}
				{notice.action && (
					<button
						onClick={() => {
							notice.action?.onAction();
							onDismiss();
						}}
						type="button"
					>
						{notice.action.label}
					</button>
				)}
			</p>
		</div>
	);
}
