import { useEffect, useRef, useState } from "react";

export type NoticeOptions = {
	message: string;
	action?: { label: string; onAction: () => void };
	/** Milliseconds before the notice clears; defaults to 2000. */
	duration?: number;
};

export function useNavigationNotice() {
	let [notice, setNotice] = useState<NoticeOptions>();
	let timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	let show = (options?: NoticeOptions) => {
		clearTimeout(timer.current);
		setNotice(options);
		if (options) timer.current = setTimeout(show, options.duration ?? 2000);
	};
	useEffect(() => () => clearTimeout(timer.current), []);
	return { notice, show };
}
