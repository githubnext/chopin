/**
 * Callout headings and type picker.
 *
 * Type and title are node attributes rather than content, so they render as
 * chrome. The title still edits like document text; the type picker stays
 * behind its icon until asked for. Changing either is a local Yjs update —
 * callouts already carry an id, so nothing here needs the server.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	CheckIcon,
	InfoIcon,
	LightbulbIcon,
	SirenIcon,
	StarFourIcon,
	WarningIcon,
} from "@phosphor-icons/react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { readOnly$ } from "@mdxeditor/editor";
import { useCellValue } from "@mdxeditor/gurx";
import { $getNodeByKey, $getRoot, $isElementNode } from "lexical";
import { $isCalloutNode, CALLOUT_TYPES } from "@chopin/dialect";

import type { CalloutType } from "@chopin/dialect";
import type { ElementNode, LexicalEditor } from "lexical";

type Callout = { key: string; type: CalloutType; title: string };

const LABELS: Record<CalloutType, string> = {
	note: "Note",
	tip: "Tip",
	important: "Important",
	warning: "Warning",
	danger: "Danger",
};

function TypeIcon({ type, size = 17 }: { type: CalloutType; size?: number }) {
	let props = { "aria-hidden": true, size, weight: "bold" } as const;
	switch (type) {
		case "note":
			return <InfoIcon {...props} />;
		case "tip":
			return <LightbulbIcon {...props} />;
		case "important":
			return <StarFourIcon {...props} />;
		case "warning":
			return <WarningIcon {...props} />;
		case "danger":
			return <SirenIcon {...props} />;
	}
}

function collect(editor: LexicalEditor): Callout[] {
	let out: Callout[] = [];

	editor.getEditorState().read(() => {
		let walk = (node: ElementNode) => {
			for (let child of node.getChildren()) {
				if ($isCalloutNode(child)) {
					out.push({
						key: child.getKey(),
						type: child.getCalloutType(),
						title: child.getTitle(),
					});
				}
				if ($isElementNode(child)) walk(child);
			}
		};
		walk($getRoot());
	});

	return out;
}

function Heading(
	{ callout, editor, disabled }: {
		callout: Callout;
		editor: LexicalEditor;
		disabled?: boolean;
	},
) {
	let [choosing, setChoosing] = useState(false);
	let heading = useRef<HTMLDivElement>(null);
	let trigger = useRef<HTMLButtonElement>(null);
	let current = useRef<HTMLButtonElement>(null);

	let setType = useCallback((type: CalloutType) => {
		editor.update(() => {
			let node = $getNodeByKey(callout.key);
			if ($isCalloutNode(node)) node.setCalloutType(type);
		});
	}, [editor, callout.key]);

	let setTitle = useCallback((title: string) => {
		editor.update(() => {
			let node = $getNodeByKey(callout.key);
			if ($isCalloutNode(node)) node.setTitle(title);
		});
	}, [editor, callout.key]);

	useEffect(() => {
		if (choosing) current.current?.focus();
	}, [choosing]);

	useEffect(() => {
		if (!choosing) return;
		let dismiss = (event: PointerEvent) => {
			if (!heading.current?.contains(event.target as Node)) setChoosing(false);
		};
		document.addEventListener("pointerdown", dismiss);
		return () => document.removeEventListener("pointerdown", dismiss);
	}, [choosing]);

	let choose = (type: CalloutType) => {
		setType(type);
		setChoosing(false);
		trigger.current?.focus();
	};

	let navigate = (event: React.KeyboardEvent<HTMLDivElement>) => {
		let options = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']"),
		];
		let at = options.indexOf(document.activeElement as HTMLButtonElement);
		let next: number;

		if (event.key === "ArrowDown") next = (at + 1) % options.length;
		else if (event.key === "ArrowUp") next = (at - 1 + options.length) % options.length;
		else if (event.key === "Home") next = 0;
		else if (event.key === "End") next = options.length - 1;
		else if (event.key === "Escape") {
			setChoosing(false);
			trigger.current?.focus();
			return event.preventDefault();
		} else return;

		event.preventDefault();
		options[next]?.focus();
	};

	let updateTitle = (element: HTMLElement) => {
		let raw = element.textContent ?? "";
		let title = raw.replace(/[\r\n]+/g, " ").slice(0, 100);
		// A pasted heading may contain rich markup or line breaks. The title is a
		// plain attribute, so make the DOM tell that same truth immediately.
		if (raw !== title || element.childElementCount > 0) {
			element.textContent = title;
			let range = document.createRange();
			range.selectNodeContents(element);
			range.collapse(false);
			window.getSelection()?.removeAllRanges();
			window.getSelection()?.addRange(range);
		}
		setTitle(title);
	};

	return (
		<div
			contentEditable={false}
			className="plan-callout-heading"
			ref={heading}
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setChoosing(false);
			}}
		>
			<button
				aria-expanded={choosing}
				aria-haspopup="menu"
				aria-label={`Change callout type: ${LABELS[callout.type]}`}
				className="plan-callout-type"
				data-callout-type={callout.type}
				disabled={disabled}
				onClick={() => setChoosing(open => !open)}
				ref={trigger}
				title={`${LABELS[callout.type]} — change callout type`}
				type="button"
			>
				<TypeIcon type={callout.type} />
			</button>

			{choosing && (
				<div
					aria-label="Callout type"
					className="plan-callout-menu"
					onKeyDown={navigate}
					role="menu"
				>
					{CALLOUT_TYPES.map(type => (
						<button
							aria-checked={type === callout.type}
							className="plan-callout-option"
							data-callout-type={type}
							key={type}
							onClick={() => choose(type)}
							ref={type === callout.type ? current : undefined}
							role="menuitemradio"
							type="button"
						>
							<TypeIcon type={type} size={16} />
							<span>{LABELS[type]}</span>
							{type === callout.type && <CheckIcon aria-hidden="true" size={14} weight="bold" />}
						</button>
					))}
				</div>
			)}

			<span
				aria-label="Callout title"
				className="plan-callout-title"
				contentEditable={!disabled}
				data-placeholder={LABELS[callout.type]}
				onInput={event => updateTitle(event.currentTarget)}
				onKeyDown={event => {
					if (event.key !== "Enter") return;
					event.preventDefault();
					event.currentTarget.blur();
				}}
				role={disabled ? undefined : "textbox"}
				suppressContentEditableWarning
				tabIndex={disabled ? undefined : 0}
			>
				{callout.title}
			</span>
		</div>
	);
}

export function CalloutPlugin() {
	let [editor] = useLexicalComposerContext();
	let disabled = useCellValue(readOnly$);
	let [callouts, setCallouts] = useState<Callout[]>([]);

	useEffect(() => {
		let update = () => setCallouts(collect(editor));
		update();
		return editor.registerUpdateListener(update);
	}, [editor]);

	return (
		<>
			{callouts.map(callout => {
				let host = editor.getElementByKey(callout.key)
					?.querySelector<HTMLElement>("[data-plan-chrome='callout']");
				if (!host) return null;
				return createPortal(
					<Heading callout={callout} editor={editor} disabled={disabled} />,
					host,
					callout.key,
				);
			})}
		</>
	);
}
