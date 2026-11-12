import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, CopyIcon } from "@chopin/icons";
import { UnfoldPanel, UnfoldToggle, useUnfold } from "@chopin/visuals/unfold";

import type { FixStep, MachineFix } from "./machine-fix";

import "./fix-steps.css";

/**
 * The machine fix-it steps (`machine-fix.ts`), drawn once for the machine button's menu and for
 * the How to fix of chopin's ephemeral row: a bold title, one plain sentence of why, numbered steps
 * of one action each with any command alone in a block that copies it, and a foot with Show details
 * at its start and, at its end, how often it was tried and Learn more. The machine's own words
 * unfold under the foot.
 *
 * Calm on purpose, as Slack's help is: no alarm colour, since nothing is lost and Chopin keeps
 * trying. Inside a menu (`menu`) each control is one of its items, so the arrow keys reach them.
 */
export default function FixSteps(
	{ fix, menu = false, titled = true, onNavigate, onChoose }: {
		fix: MachineFix;
		menu?: boolean;
		/** Without its title where the sentence above it already says it, as chopin's row does. */
		titled?: boolean;
		/** Follows a link to a page of Chopin's own, where the host has to close first. */
		onNavigate?: (href: string) => void;
		/** Opens the machine button's choice. */
		onChoose?: () => void;
	},
) {
	let details = useUnfold();
	let item = menu ? "menuitem" : undefined;
	return (
		<div aria-label={fix.title} className="fix-steps" data-fix={fix.kind} role="group">
			{/* Text, not paragraphs or code: a menu may hold nothing with a role but its items. */}
			{titled && <div className="fix-steps-title">{fix.title}</div>}
			<div className="fix-steps-why">{fix.why}</div>
			{/* A menu's items need a menu or group above them, not a list, so in a menu the steps are a group. */}
			<ol
				aria-label={menu ? "Steps" : undefined}
				className="fix-steps-list"
				role={menu ? "group" : undefined}
			>
				{fix.steps.map((step, index) => (
					<Step
						key={index}
						menu={menu}
						onChoose={onChoose}
						onNavigate={onNavigate}
						step={step}
					/>
				))}
			</ol>
			<div>
				<div className="fix-steps-foot">
					{fix.details && (
						<UnfoldToggle className="fix-steps-toggle" role={item} unfold={details}>
							{details.open ? "Hide details" : "Show details"}
						</UnfoldToggle>
					)}
					<span className="fix-steps-end">
						{fix.tried && <span className="fix-steps-tried">{fix.tried}</span>}
						<a
							className="fix-steps-link"
							href={fix.learnMore}
							rel="noreferrer"
							role={item}
							target="_blank"
						>
							Learn more
						</a>
					</span>
				</div>
				{fix.details && (
					<UnfoldPanel unfold={details}>
						<pre className="fix-steps-output">{fix.details.join("\n")}</pre>
					</UnfoldPanel>
				)}
			</div>
		</div>
	);
}

function Step(
	{ step, menu, onNavigate, onChoose }: {
		step: FixStep;
		menu: boolean;
		onNavigate?: (href: string) => void;
		onChoose?: () => void;
	},
) {
	let item = menu ? "menuitem" : undefined;
	return (
		<li className="fix-steps-step" role={menu ? "none" : undefined}>
			<span>
				{step.text}
				{step.link && (
					<>
						{" "}
						<a
							className="fix-steps-link"
							href={step.link.href}
							onClick={onNavigate
								? event => {
									event.preventDefault();
									onNavigate(step.link!.href);
								}
								: undefined}
							role={item}
						>
							{step.link.label}
						</a>
					</>
				)}
				{step.choose && onChoose && (
					<>
						{" "}
						<button className="fix-steps-link" onClick={onChoose} role={item} type="button">
							Choose machine
						</button>
					</>
				)}
			</span>
			{step.hint && <span className="fix-steps-hint">{step.hint}</span>}
			{step.command && <CommandBlock command={step.command} menu={menu} />}
		</li>
	);
}

/** One command, monospace, wrapping inside its block, with a Copy button that copies it whole. */
export function CommandBlock({ command, menu = false }: { command: string; menu?: boolean }) {
	let [copied, setCopied] = useState<"copied" | "failed">();
	useEffect(() => {
		if (!copied) return;
		let timer = window.setTimeout(() => setCopied(undefined), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);
	let label = copied === "copied"
		? "Copied"
		: copied === "failed"
		? "Select the command to copy it"
		: `Copy ${command}`;
	return (
		<div className="fix-steps-command">
			<span className="fix-steps-code">{command}</span>
			<button
				aria-label={label}
				className="btn btn-icon-xs btn-ghost fix-steps-copy"
				data-copied={copied === "copied" || undefined}
				data-tooltip={copied === "copied" ? "Copied" : "Copy"}
				onClick={() =>
					navigator.clipboard.writeText(command).then(
						() => setCopied("copied"),
						() => setCopied("failed"),
					)}
				role={menu ? "menuitem" : undefined}
				type="button"
			>
				{copied === "copied" ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
			</button>
			{/* Said from outside the menu, which may hold nothing but its items. */}
			{typeof document !== "undefined" && createPortal(
				<span aria-live="polite" className="sr-only">{copied === "copied" ? "Copied" : ""}</span>,
				document.body,
			)}
		</div>
	);
}
