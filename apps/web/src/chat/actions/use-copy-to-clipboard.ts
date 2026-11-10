/**
 * Adapted from assistant-ui's `use-copy-to-clipboard` hook (see NOTICE.md): `isCopied` turns on only
 * once the clipboard has accepted the text, and off again after `copiedDuration`; `isFailed` says the
 * same for a write the clipboard refused, which upstream ignores.
 */
import { useEffect, useRef, useState } from "react";

export type UseCopyToClipboardOptions = {
	copiedDuration?: number;
};

export type Confirmation = { copied: boolean; failed: boolean };

type Timers = {
	set: (callback: () => void, ms: number) => unknown;
	clear: (handle: unknown) => void;
};

const BROWSER: Timers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CopyConfirmation {
	state: Confirmation = { copied: false, failed: false };
	private copiedTimer: unknown;
	private failedTimer: unknown;

	constructor(
		private publish: (state: Confirmation) => void,
		private timers: Timers = BROWSER,
	) {}

	begin(): void {
		this.timers.clear(this.failedTimer);
		this.failedTimer = undefined;
		this.change({ failed: false });
	}

	copied(duration: number): void {
		this.timers.clear(this.copiedTimer);
		this.change({ copied: true });
		this.copiedTimer = this.timers.set(() => {
			this.copiedTimer = undefined;
			this.change({ copied: false });
		}, duration);
	}

	refused(duration: number): void {
		this.timers.clear(this.copiedTimer);
		this.copiedTimer = undefined;
		this.timers.clear(this.failedTimer);
		this.change({ copied: false, failed: true });
		this.failedTimer = this.timers.set(() => {
			this.failedTimer = undefined;
			this.change({ failed: false });
		}, duration);
	}

	stop(): void {
		this.timers.clear(this.copiedTimer);
		this.timers.clear(this.failedTimer);
		this.copiedTimer = undefined;
		this.failedTimer = undefined;
		this.change({ copied: false, failed: false });
	}

	private change(next: Partial<Confirmation>): void {
		let state = { ...this.state, ...next };
		if (state.copied === this.state.copied && state.failed === this.state.failed) return;
		this.state = state;
		this.publish(state);
	}
}

export let useCopyToClipboard = ({ copiedDuration = 3000 }: UseCopyToClipboardOptions = {}) => {
	let [state, setState] = useState<Confirmation>({ copied: false, failed: false });
	let confirmation = useRef<CopyConfirmation>(undefined);
	confirmation.current ??= new CopyConfirmation(setState);
	let scopeGenerationRef = useRef(0);

	useEffect(
		() => () => {
			scopeGenerationRef.current += 1;
			confirmation.current?.stop();
		},
		[],
	);

	let copyToClipboard = (value: string) => {
		let current = confirmation.current!;
		current.begin();
		if (typeof navigator === "undefined" || !navigator.clipboard) {
			return current.refused(copiedDuration);
		}

		let scopeGeneration = scopeGenerationRef.current;
		navigator.clipboard.writeText(value).then(
			() => {
				if (scopeGeneration === scopeGenerationRef.current) current.copied(copiedDuration);
			},
			() => {
				if (scopeGeneration === scopeGenerationRef.current) current.refused(copiedDuration);
			},
		);
	};

	return { isCopied: state.copied, isFailed: state.failed, copyToClipboard };
};
