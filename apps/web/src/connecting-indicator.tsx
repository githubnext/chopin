import "./connecting-indicator.css";

/**
 * Connecting, drawn: three petrol dots that brighten in turn, left to right, as Slack's typing dots
 * do, in place of a spinner. Only opacity moves, slowly and with the shared in-out ease, so nothing
 * turns and nothing changes size. Under reduced motion the dots hold still, stepped from faint to
 * full, an ellipsis that still reads as under way. It is decoration: the words beside it, the
 * button's name or the banner's text, and the page's live region say what is connecting.
 *
 * One drawing everywhere a machine or the Planner is connected to: the connection banner's icon,
 * at the 16px of the icon it replaced, and the machine button's corner badge, sized by its CSS.
 */
export function ConnectingIndicator(
	{ className, size = 16 }: { className?: string; size?: number },
) {
	return (
		<svg
			aria-hidden="true"
			className={className ? `connecting-indicator ${className}` : "connecting-indicator"}
			data-connecting=""
			focusable="false"
			height={size}
			viewBox="0 0 16 6"
			width={size}
		>
			<circle cx="3" cy="3" r="1.75" />
			<circle cx="8" cy="3" r="1.75" />
			<circle cx="13" cy="3" r="1.75" />
		</svg>
	);
}
