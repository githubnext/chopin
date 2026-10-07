import { useLayoutEffect, useRef, useState } from "react";
import { MessageIcon } from "@chopin/icons";

import { ChopinMark } from "./agent-mark";

export function ModeSwitch(
	{ effectiveMode, disabled, onToggle }: {
		effectiveMode: boolean;
		disabled: boolean;
		onToggle: () => void;
	},
) {
	let button = useRef<HTMLButtonElement>(null);
	let label = useRef<HTMLSpanElement>(null);
	let [width, setWidth] = useState<number>();
	useLayoutEffect(() => {
		let element = label.current;
		let control = button.current;
		if (!element || !control) return;
		function measure() {
			let text = getComputedStyle(element!);
			let style = getComputedStyle(control!);
			let symbol = control!.querySelector<HTMLElement>(".composer-mode-symbol")!;
			setWidth(
				parseFloat(text.width) + symbol.offsetWidth + parseFloat(style.columnGap)
					+ parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
			);
		}
		measure();
		let observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [effectiveMode]);
	return (
		<span
			className="composer-mode-trigger"
			data-tooltip="Shift+Tab to switch mode."
			data-tooltip-verbatim=""
		>
			<button
				ref={button}
				type="button"
				className="composer-mode btn btn-sm btn-ghost"
				data-press="none"
				aria-pressed={effectiveMode}
				aria-label="Talk to Chopin"
				disabled={disabled}
				onClick={onToggle}
				aria-keyshortcuts="Shift+Tab"
				style={{ width }}
			>
				<span className="composer-mode-symbol">
					{effectiveMode ? <ChopinMark /> : <MessageIcon size={14} />}
				</span>
				<span className="composer-mode-label" ref={label}>
					{effectiveMode ? "Chopin" : "Chat"}
				</span>
			</button>
		</span>
	);
}
