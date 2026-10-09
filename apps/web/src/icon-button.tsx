import type { KeyboardEventHandler, MouseEventHandler, ReactNode, Ref } from "react";

type IconButtonRecipe = {
	placement?: "sidebar" | "sidebar-document";
	pending?: boolean;
	glyph?: "compact" | "default";
	size?: "compact" | "normal";
	tone?: "ghost" | "nested";
};

type IconButtonProps = IconButtonRecipe & {
	"aria-busy"?: boolean;
	"aria-controls"?: string;
	"aria-expanded"?: boolean;
	"aria-haspopup"?: "menu";
	"aria-label": string;
	children: ReactNode;
	"data-tooltip"?: string;
	"data-tooltip-shortcut"?: string;
	disabled?: boolean;
	onClick?: MouseEventHandler<HTMLButtonElement>;
	onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
	ref?: Ref<HTMLButtonElement>;
	title?: string;
};

export function IconButton(props: IconButtonProps) {
	return (
		<button
			aria-busy={props["aria-busy"]}
			aria-controls={props["aria-controls"]}
			aria-expanded={props["aria-expanded"]}
			aria-haspopup={props["aria-haspopup"]}
			aria-label={props["aria-label"]}
			className={`app-icon-button btn ${
				props.placement === "sidebar-document"
					? "project-sidebar-document-action"
					: props.placement
					? "project-sidebar-action"
					: ""
			} ${props.pending ? "project-sidebar-action-pending" : ""}`}
			data-glyph={props.glyph ?? "default"}
			data-press="small"
			data-size={props.size ?? "normal"}
			data-tone={props.tone ?? "ghost"}
			data-tooltip={props["data-tooltip"]}
			data-tooltip-shortcut={props["data-tooltip-shortcut"]}
			disabled={props.disabled}
			onClick={props.onClick}
			onKeyDown={props.onKeyDown}
			ref={props.ref}
			title={props.title}
			type="button"
		>
			{props.children}
		</button>
	);
}
