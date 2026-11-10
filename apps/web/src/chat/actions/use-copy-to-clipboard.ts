/**
 * Adapted from assistant-ui's `use-copy-to-clipboard` hook (see NOTICE.md): `isCopied` turns on only
 * once the clipboard has accepted the text, and off again after `copiedDuration`; `isFailed` says the
 * same for a write the clipboard refused, which upstream ignores.
 */
import { useEffect, useRef, useState } from "react";

export type UseCopyToClipboardOptions = {
	copiedDuration?: number;
};

export let useCopyToClipboard = ({ copiedDuration = 3000 }: UseCopyToClipboardOptions = {}) => {
	let [isCopied, setIsCopied] = useState<boolean>(false);
	let [isFailed, setIsFailed] = useState<boolean>(false);
	let failedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let scopeGenerationRef = useRef(0);

	useEffect(
		() => () => {
			scopeGenerationRef.current += 1;
			clearTimeout(failedTimerRef.current);
			if (copiedTimerRef.current === undefined) return;

			clearTimeout(copiedTimerRef.current);
			copiedTimerRef.current = undefined;
			setIsCopied(false);
		},
		[],
	);

	let fail = () => {
		clearTimeout(failedTimerRef.current);
		setIsFailed(true);
		failedTimerRef.current = setTimeout(() => setIsFailed(false), copiedDuration);
	};

	let copyToClipboard = (value: string) => {
		clearTimeout(failedTimerRef.current);
		setIsFailed(false);
		if (typeof navigator === "undefined" || !navigator.clipboard) return fail();

		let scopeGeneration = scopeGenerationRef.current;
		navigator.clipboard.writeText(value).then(
			() => {
				if (scopeGeneration !== scopeGenerationRef.current) return;

				if (copiedTimerRef.current !== undefined) clearTimeout(copiedTimerRef.current);
				setIsCopied(true);
				copiedTimerRef.current = setTimeout(() => {
					copiedTimerRef.current = undefined;
					setIsCopied(false);
				}, copiedDuration);
			},
			() => {
				if (scopeGeneration === scopeGenerationRef.current) fail();
			},
		);
	};

	return { isCopied, isFailed, copyToClipboard };
};
