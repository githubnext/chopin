import "./connecting-indicator.css";

/**
 * Connecting, drawn: three petrol dots that brighten in turn, left to right, as Slack's typing dots
 * do, in place of a spinner. Only opacity moves, slowly and with the shared in-out ease, so nothing
 * turns and nothing changes size. Under reduced motion the dots hold still, stepped from faint to
 * full, an ellipsis that still reads as under way. It is decoration: the words beside it, the
 * button's name or the banner's text, and the page's live region say what is connecting.
 *
 * One drawing everywhere a machine or the Planner is connected to: the connection banner's icon,
 * in the 16px box of the icon it replaced, and the machine button's corner badge, sized by its CSS.
 * The dots are boxes drawn by CSS, not artwork, so they size and colour from Chopin's tokens.
 */
export function ConnectingIndicator({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={className ? `connecting-indicator ${className}` : "connecting-indicator"}
			data-connecting=""
		>
			<span className="connecting-dot" />
			<span className="connecting-dot" />
			<span className="connecting-dot" />
		</span>
	);
}
