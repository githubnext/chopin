import { useEffect, useRef, useState } from "react";
import { PlusIcon } from "@chopin/icons";

export function AddOption(
	{ disabled, onAdd, onCancel, onCommit, onEdit }: {
		disabled: boolean;
		onAdd?: (label: string) => Promise<{ ok: true } | { ok: false; message: string }>;
		onCancel?: () => void;
		onCommit?: () => void;
		onEdit?: () => void;
	},
) {
	let [open, setOpen] = useState(false);
	let [value, setValue] = useState("");
	let [error, setError] = useState<string>();
	let [busy, setBusy] = useState(false);
	let field = useRef<HTMLInputElement>(null);
	let trigger = useRef<HTMLButtonElement>(null);
	let focusField = useRef(false);
	let focusTrigger = useRef(false);
	let attempt = useRef(0);
	let locked = disabled || busy || !onAdd;

	useEffect(() => {
		if (!open) {
			if (!focusTrigger.current) return;
			focusTrigger.current = false;
			trigger.current?.focus();
			return;
		}
		if (!focusField.current) return;
		focusField.current = false;
		field.current?.focus();
	}, [open]);

	useEffect(() => {
		let viewport = window.visualViewport;
		if (!viewport) return;
		let height = viewport.height;
		let reveal = () => {
			let previous = height;
			height = viewport.height;
			let control = field.current;
			if (height >= previous || document.activeElement !== control || !control) return;
			let bounds = control.getBoundingClientRect();
			let top = viewport.offsetTop;
			let bottom = top + viewport.height;
			if (bounds.top >= top && bounds.bottom <= bottom) return;
			requestAnimationFrame(() => control.scrollIntoView({ block: "nearest" }));
		};

		viewport.addEventListener("resize", reveal);
		return () => viewport.removeEventListener("resize", reveal);
	}, []);

	if (!open) {
		return (
			<button
				aria-disabled={!onAdd || undefined}
				aria-label="Add another option"
				className="mx-4 mt-1 flex items-center gap-1 rounded-sm text-base text-text-tertiary hover:text-text-secondary aria-disabled:cursor-not-allowed"
				onClick={() => {
					if (!onAdd) return;
					focusField.current = true;
					setOpen(true);
				}}
				disabled={!onAdd}
				ref={trigger}
				type="button"
			>
				Add another
				<PlusIcon aria-hidden="true" size={14} />
				<span className="sr-only">option</span>
			</button>
		);
	}

	return (
		<div className="px-4 pt-1">
			<input
				aria-disabled={locked || undefined}
				aria-label="New option"
				className="field w-full px-2 py-1.5 text-base"
				maxLength={200}
				onChange={event => {
					if (locked) return;
					setValue(event.currentTarget.value);
					setError(undefined);
					onEdit?.();
				}}
				onKeyDown={async event => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						attempt.current++;
						focusField.current = false;
						focusTrigger.current = true;
						setOpen(false);
						setValue("");
						setError(undefined);
						onCancel?.();
						return;
					}
					if (event.key !== "Enter" || locked || !onAdd) return;
					event.preventDefault();
					let current = ++attempt.current;
					setBusy(true);
					let result: { ok: true } | { ok: false; message: string };
					try {
						result = await onAdd(value);
					} catch {
						result = { ok: false, message: "Could not add it." };
					}
					setBusy(false);
					if (current !== attempt.current) return;
					if (result.ok) {
						setValue("");
						onCommit?.();
					} else setError(result.message);
				}}
				placeholder="Type an option and press Enter"
				readOnly={locked}
				ref={field}
				value={value}
			/>
			{error && <p className="m-0 mt-1 text-sm text-destructive-ink" role="alert">{error}</p>}
		</div>
	);
}
