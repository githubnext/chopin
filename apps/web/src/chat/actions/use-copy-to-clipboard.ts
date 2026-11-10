/**
 * Adapted from assistant-ui's `use-copy-to-clipboard` hook (see NOTICE.md): `isCopied` turns on only
 * once the clipboard has accepted the text, and off again after `copiedDuration`.
 */
import { useEffect, useRef, useState } from "react";

export type UseCopyToClipboardOptions = {
	copiedDuration?: number;
};

export let useCopyToClipboard = ({ copiedDuration = 3000 }: UseCopyToClipboardOptions = {}) => {
	let [isCopied, setIsCopied] = useState<boolean>(false);
	let copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	let scopeGenerationRef = useRef(0);

	useEffect(
		() => () => {
			scopeGenerationRef.current += 1;
			if (copiedTimerRef.current === undefined) return;

			clearTimeout(copiedTimerRef.current);
			copiedTimerRef.current = undefined;
			setIsCopied(false);
		},
		[],
	);

	let copyToClipboard = (value: string) => {
		if (typeof navigator === "undefined" || !navigator.clipboard) return;

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
			() => {},
		);
	};

	return { isCopied, copyToClipboard };
};
