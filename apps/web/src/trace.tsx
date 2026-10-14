import { createContext, useContext, useId, useState } from "react";
import { ChevronIcon } from "@chopin/icons";
import { MotionDisclosure } from "@chopin/editor";

import { motionContract } from "./motion-contract";
import { motionImmediately } from "./motion-input";

import type { ReactNode } from "react";

import "./trace.css";

/*
 * An agent trace after shadcn's `Trace`: quiet lines of icon, title and
 * description, where a line can fold open to an indented, rule-bordered body.
 */

type TraceStatus = "running" | "error" | "pending";

export function Trace(
	{ children, label, list = false, scroll = false }: {
		children: ReactNode;
		label?: string;
		list?: boolean;
		scroll?: boolean;
	},
) {
	return (
		<div
			aria-label={label}
			className={scroll ? "trace trace-scroll" : "trace"}
			data-slot="trace"
			role={list ? "list" : undefined}
		>
			{children}
		</div>
	);
}

export function TraceLine({ children, status }: { children: ReactNode; status?: TraceStatus }) {
	return (
		<span className="trace-line" data-slot="trace-line" data-status={status}>
			{children}
		</span>
	);
}

export function TraceIcon({ children }: { children: ReactNode }) {
	return (
		<span aria-hidden="true" className="trace-icon" data-slot="trace-icon">
			{children}
		</span>
	);
}

/** `enter` plays a short rise when the title's `key` changes. */
export function TraceTitle(
	{ children, enter = false, wrap = false }: {
		children: ReactNode;
		enter?: boolean;
		wrap?: boolean;
	},
) {
	return (
		<span
			className="trace-title"
			data-enter={enter || undefined}
			data-slot="trace-title"
			data-wrap={wrap || undefined}
		>
			{children}
		</span>
	);
}

export function TraceDescription(
	{ children, tone }: { children: ReactNode; tone?: "destructive" },
) {
	return (
		<span className="trace-description" data-slot="trace-description" data-tone={tone}>
			{children}
		</span>
	);
}

type Disclosure = { contentId: string; open: boolean; toggle: () => void };

let TraceContext = createContext<Disclosure | undefined>(undefined);

function useDisclosure(part: string): Disclosure {
	let value = useContext(TraceContext);
	if (!value) throw new Error(`${part} must be inside TraceCollapsible`);
	return value;
}

export function TraceCollapsible(
	{ children, defaultOpen = false }: { children: ReactNode; defaultOpen?: boolean },
) {
	let [open, setOpen] = useState(defaultOpen);
	let contentId = useId();
	return (
		<TraceContext.Provider value={{ contentId, open, toggle: () => setOpen(value => !value) }}>
			<div
				className="trace-collapsible"
				data-slot="trace-collapsible"
				data-state={open ? "open" : "closed"}
			>
				{children}
			</div>
		</TraceContext.Provider>
	);
}

export function TraceCollapsibleTrigger({ children }: { children: ReactNode }) {
	let { contentId, open, toggle } = useDisclosure("TraceCollapsibleTrigger");
	let state = open ? "open" : "closed";
	return (
		<button
			aria-controls={contentId}
			aria-expanded={open}
			className="trace-collapsible-trigger"
			data-slot="trace-collapsible-trigger"
			onClick={toggle}
			type="button"
		>
			{children}
			<span
				aria-hidden="true"
				className="trace-icon trace-chevron"
				data-slot="trace-icon"
				data-state={state}
			>
				<ChevronIcon size={12} />
			</span>
		</button>
	);
}

/** `surface` names the fold for `data-motion-disclosure`. */
export function TraceCollapsibleContent(
	{ children, surface }: { children: ReactNode; surface: string },
) {
	let { contentId, open } = useDisclosure("TraceCollapsibleContent");
	return (
		<div className="trace-collapsible-content" data-slot="trace-collapsible-content" id={contentId}>
			<MotionDisclosure
				id={`${contentId}-motion`}
				immediately={motionImmediately()}
				motion={motionContract("collapse")}
				open={open}
				surface={surface}
			>
				<div
					className="trace-collapsible-content-inner"
					data-slot="trace-collapsible-content-inner"
				>
					{children}
				</div>
			</MotionDisclosure>
		</div>
	);
}
