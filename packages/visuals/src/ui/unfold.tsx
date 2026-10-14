import { useCallback, useId, useRef, useState } from "react";
import { ChevronIcon } from "@chopin/icons";
import { Accordion } from "@base-ui/react/accordion";

import type { ComponentProps, ReactNode, RefObject } from "react";

export type UnfoldTriggerProps = {
	"aria-controls": string;
	"aria-expanded": boolean;
	onClick: () => void;
	ref: RefObject<HTMLButtonElement | null>;
	type: "button";
};

export type UnfoldSpeed = "card" | "accordion";

export type Unfold = {
	id: string;
	open: boolean;
	speed: UnfoldSpeed;
	panelRef: RefObject<HTMLDivElement | null>;
	setOpen: (open: boolean, options?: { focusTrigger?: boolean }) => void;
	toggle: () => void;
	trigger: UnfoldTriggerProps;
};

/** `card` previews fold at the linger pace; plain accordions use the accordion token. */
export function useUnfold(defaultOpen = false, speed: UnfoldSpeed = "accordion"): Unfold {
	let id = useId();
	let [open, setState] = useState(defaultOpen);
	let triggerRef = useRef<HTMLButtonElement>(null);
	let panelRef = useRef<HTMLDivElement>(null);
	let setOpen = useCallback((next: boolean, options: { focusTrigger?: boolean } = {}) => {
		let panel = panelRef.current;
		// A closing panel turns inert; focus left inside it would fall to the page.
		if (!next && (options.focusTrigger || panel?.contains(panel.ownerDocument.activeElement))) {
			triggerRef.current?.focus({ preventScroll: true });
		}
		setState(next);
	}, []);
	let toggle = useCallback(() => setOpen(!open), [open, setOpen]);
	return {
		id,
		open,
		panelRef,
		setOpen,
		speed,
		toggle,
		trigger: {
			"aria-controls": id,
			"aria-expanded": open,
			onClick: toggle,
			ref: triggerRef,
			type: "button",
		},
	};
}

function classes(...names: (string | undefined)[]): string {
	return names.filter(Boolean).join(" ");
}

export type UnfoldToggleProps =
	& Omit<ComponentProps<"button">, "aria-controls" | "aria-expanded" | "onClick" | "ref" | "type">
	& { unfold: Unfold };

export function UnfoldToggle({ children, className, unfold, ...props }: UnfoldToggleProps) {
	return (
		<button
			{...props}
			{...unfold.trigger}
			className={classes("cv-unfold-toggle", className)}
			data-slot="unfold-toggle"
			data-unfold-speed={unfold.speed}
		>
			{children}
			<ChevronIcon aria-hidden="true" className="cv-unfold-chevron" size={12} />
		</button>
	);
}

export type UnfoldPanelProps = Omit<ComponentProps<"div">, "id" | "ref"> & { unfold: Unfold };

/** Stays mounted so a fold can reverse from any frame; closed content is inert. */
export function UnfoldPanel({ children, className, unfold, ...props }: UnfoldPanelProps) {
	return (
		<div
			{...props}
			aria-hidden={unfold.open ? undefined : true}
			className={classes("cv-unfold", className)}
			data-open={unfold.open ? "" : undefined}
			data-slot="unfold"
			data-unfold-speed={unfold.speed}
			id={unfold.id}
			inert={!unfold.open}
			ref={unfold.panelRef}
		>
			<div className="cv-unfold-clip">
				<div className="cv-unfold-content">{children}</div>
			</div>
		</div>
	);
}

export type UnfoldSectionProps = {
	children: ReactNode;
	className?: string;
	defaultOpen?: boolean;
	label: ReactNode;
};

export function UnfoldSection({ children, className, defaultOpen, label }: UnfoldSectionProps) {
	return (
		<div className={className} data-slot="unfold-section">
			<Accordion.Root defaultValue={defaultOpen ? ["section"] : []} keepMounted>
				<Accordion.Item value="section">
					<Accordion.Header className="cv-unfold-section-heading">
						<Accordion.Trigger
							className="cv-unfold-toggle cv-unfold-section-toggle"
							data-slot="unfold-toggle"
							data-unfold-speed="accordion"
						>
							{label}
							<ChevronIcon aria-hidden="true" className="cv-unfold-chevron" size={12} />
						</Accordion.Trigger>
					</Accordion.Header>
					<Accordion.Panel
						className="cv-unfold cv-unfold-accordion"
						data-slot="unfold"
						data-unfold-speed="accordion"
					>
						<div className="cv-unfold-clip">
							<div className="cv-unfold-content">
								<div className="cv-unfold-section-body">{children}</div>
							</div>
						</div>
					</Accordion.Panel>
				</Accordion.Item>
			</Accordion.Root>
		</div>
	);
}
