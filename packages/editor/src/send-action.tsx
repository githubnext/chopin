export function SendAction(
	{ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void },
) {
	return (
		<button
			aria-label={label}
			className="send-action btn btn-icon btn-primary rounded-full"
			disabled={disabled}
			onClick={onClick}
			title={label}
			type="button"
		>
			<svg aria-hidden="true" className="send-action-icon" viewBox="0 0 18 18">
				<path d="M9 16V3M13.25 7.75 9 3.5 4.75 7.75" />
			</svg>
		</button>
	);
}
