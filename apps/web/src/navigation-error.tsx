import { InlineNotice } from "@chopin/visuals/inline-notice";

export function NavigationError(
	{ message, onRetry, retryLabel = "Try again" }: {
		message: string;
		onRetry?: () => void;
		retryLabel?: string;
	},
) {
	return (
		<div className="navigation-error">
			<InlineNotice
				message={message === "Failed to fetch" ? "Could not reach Chopin." : message}
				actions={onRetry && (
					<button className="btn btn-compact btn-outline" onClick={onRetry} type="button">
						{retryLabel}
					</button>
				)}
			/>
		</div>
	);
}
