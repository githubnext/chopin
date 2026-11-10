/**
 * The Chat's failure banner: a quiet notice with a way to try again, never a modal.
 *
 * Adapted from assistant-ui's standalone `ErrorState` element (registry item `elements-error-state`,
 * packages/ui/src/components/react/assistant-ui/elements/error-state.tsx at
 * assistant-ui/assistant-ui f92028b4), MIT License, Copyright (c) 2026 AgentbaseAI Inc.; see
 * THIRD_PARTY_NOTICES.md. Kept: `title`, `detail`, `retrying` and `onRetry`, the alert with a Retry
 * beside it, the single spinning line while it retries. Changed: Chopin's strip, icons and roles in
 * place of its Tailwind and lucide classes, the same shape and entrance as `ConnectionState`;
 * `detail` and Retry are optional (a `link` may stand in where retrying cannot help); the root
 * takes only an `id`.
 */

import { LoaderIcon, RedoIcon, WarningIcon } from "@chopin/icons";

export type ErrorStateProps = {
	/** What went wrong, in a machine's plain words. */
	title: string;
	/** More than the title says, exactly as the machine or server reported it. */
	detail?: string;
	/** A retry is under way: the banner is one quiet line. */
	retrying?: boolean;
	/** Called by Retry; without it there is no button. */
	onRetry?: () => void;
	/** Where to go about it when retrying cannot help, in the accent. */
	link?: { label: string; href: string };
	/** Retry is pressed but cannot be sent right now. */
	retryDisabled?: boolean;
	/** Which kind of failure this is, for tests and styling. */
	kind?: string;
	/** What a field's `aria-describedby` points at. */
	id?: string;
};

export function ErrorState(
	{ title, detail, retrying = false, onRetry, link, retryDisabled, kind, id }: ErrorStateProps,
) {
	if (retrying) {
		return (
			<div
				className="composer-notice"
				data-banner=""
				data-error-banner=""
				data-kind={kind}
				data-retrying=""
				data-slot="error-state"
				id={id}
				key="retrying"
				role="status"
			>
				<LoaderIcon
					className="composer-notice-icon composer-notice-spin icon-first-line"
					size={16}
				/>
				<span>Retrying</span>
			</div>
		);
	}
	return (
		<div
			className="composer-notice"
			data-banner=""
			data-error=""
			data-error-banner=""
			data-kind={kind}
			data-slot="error-state"
			id={id}
			key="error"
			role="alert"
		>
			<WarningIcon className="icon-danger icon-first-line" size={16} />
			<span>
				{title}
				{detail && <span className="composer-notice-line">{detail}</span>}
				{link && (
					<>
						{" "}
						<a className="composer-notice-link" href={link.href} rel="noreferrer" target="_blank">
							{link.label}
						</a>
					</>
				)}
			</span>
			{onRetry && (
				<button
					className="btn btn-xs btn-outline-danger"
					disabled={retryDisabled}
					onClick={onRetry}
					type="button"
				>
					<RedoIcon aria-hidden="true" />
					Retry
				</button>
			)}
		</div>
	);
}
