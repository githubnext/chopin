import { ArrowUpIcon, LoaderIcon } from "@chopin/icons";

export function SendAction(
	{ busy, label, disabled, onClick }: {
		busy?: boolean;
		label: string;
		disabled?: boolean;
		onClick: () => void;
	},
) {
	return (
		<button
			aria-busy={busy || undefined}
			aria-label={label}
			className="send-action btn btn-icon btn-primary rounded-full"
			disabled={disabled}
			onClick={onClick}
			title={label}
			type="button"
		>
			{busy
				? <LoaderIcon aria-hidden="true" data-button-loader="" size={14} />
				: <ArrowUpIcon aria-hidden="true" size={14} />}
		</button>
	);
}
