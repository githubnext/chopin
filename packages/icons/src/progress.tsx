/**
 * A progress ring: a quiet track with an arc filled to `progress` (0 to 1), starting at the top.
 * Style the track and arc through `[data-progress-track]` and `[data-progress-arc]`.
 */
export function ProgressRingIcon(
	{ progress = 0, size = 16 }: { progress?: number; size?: number },
) {
	let radius = 5.25;
	let circumference = 2 * Math.PI * radius;
	let filled = Math.min(Math.max(progress, 0), 1) * circumference;
	return (
		<svg
			aria-hidden="true"
			data-nucleo-icon=""
			fill="none"
			height={size}
			strokeWidth="1.75"
			viewBox="0 0 14 14"
			width={size}
		>
			<circle cx="7" cy="7" data-progress-track="" r={radius} stroke="currentColor" />
			<circle
				cx="7"
				cy="7"
				data-progress-arc=""
				r={radius}
				stroke="currentColor"
				strokeDasharray={`${filled} ${circumference}`}
				strokeLinecap="round"
				transform="rotate(-90 7 7)"
			/>
		</svg>
	);
}
