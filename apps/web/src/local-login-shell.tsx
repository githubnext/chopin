import chopinIcon from "./assets/figma/navigation/chopin.svg";

import type { ReactNode } from "react";

/**
 * The local-mode sign-in page: one centered column on
 * a warm ground with the brand wash, and one card that holds whichever
 * sign-in step is current. Steps swap in place; nothing opens over the page.
 */
export function LocalLoginShell(
	{ children, title = "Open your workspace" }: { children: ReactNode; title?: string },
) {
	return (
		<div className="sign-in-page" data-hosted="">
			<header className="sign-in-header">
				<span className="flex items-center gap-2">
					<img alt="" height={16} src={chopinIcon} width={16} />
					<span className="text-sm font-semibold text-brand">Chopin</span>
				</span>
				<span className="text-sm text-text-tertiary">A GitHub Next research prototype</span>
			</header>
			<main className="sign-in-main">
				<div className="sign-in-intro">
					<h1 className="sign-in-title">Plan together, in the context of the code.</h1>
					<p className="mt-4 text-base text-text-secondary">
						A shared document, a visible chat, and an agent that can read the repository without
						owning the decision.
					</p>
				</div>
				<section aria-labelledby="sign-in-heading" className="sign-in-card">
					<h2 className="text-lg font-semibold" id="sign-in-heading">{title}</h2>
					{children}
				</section>
			</main>
		</div>
	);
}
