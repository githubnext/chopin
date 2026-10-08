export type NoticeOptions = {
	message: string;
	action?: { label: string; onAction: () => void };
	/** Milliseconds before the notice clears; defaults to 2000. */
	duration?: number;
};
