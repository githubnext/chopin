import { CaretDownIcon, CheckIcon } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import * as Api from "./api";

import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";

export type RepositoryIdentity = Pick<Api.Repository, "owner" | "name" | "fullName">;

type Position = Pick<CSSProperties, "left" | "maxHeight" | "top" | "visibility" | "width">;

function repositoryHref(repository: RepositoryIdentity): string {
	return `/repositories/${encodeURIComponent(repository.owner)}/${
		encodeURIComponent(repository.name)
	}`;
}

function sameRepository(left: RepositoryIdentity | undefined, right: RepositoryIdentity): boolean {
	return left?.owner.toLowerCase() === right.owner.toLowerCase()
		&& left.name.toLowerCase() === right.name.toLowerCase();
}

function optionId(list: string, repository: Api.Repository): string {
	return `${list}-option-${repository.id}`;
}

function reauthenticate(reason: unknown): boolean {
	if (!(reason instanceof Api.ApiError) || reason.status !== 401) return false;
	location.assign("/");
	return true;
}

export function RepositoryPicker(
	{ current, initialOpen = false }: { current?: RepositoryIdentity; initialOpen?: boolean },
) {
	let trigger = useRef<HTMLButtonElement>(null);
	let panel = useRef<HTMLDivElement>(null);
	let search = useRef<HTMLInputElement>(null);
	let request = useRef<Promise<Api.RepositoryPage> | undefined>(undefined);
	let mounted = useRef(true);
	let panelId = useId();
	let listId = useId();
	let [open, setOpen] = useState(initialOpen);
	let [position, setPosition] = useState<Position>({ visibility: "hidden" });
	let [page, setPage] = useState<Api.RepositoryPage>();
	let [error, setError] = useState<unknown>();
	let [attempt, setAttempt] = useState(0);
	let [loadingMore, setLoadingMore] = useState(false);
	let [query, setQuery] = useState("");
	let [active, setActive] = useState(0);

	let normalized = query.trim().toLowerCase();
	let repositories = page?.repositories ?? [];
	let matches = normalized
		? repositories.filter(repository => repository.fullName.toLowerCase().includes(normalized))
		: repositories;
	let activeIndex = matches.length === 0 ? -1 : Math.min(active, matches.length - 1);
	let activeRepository = matches[activeIndex];

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	useEffect(() => {
		if (!open || page) return;
		let active = true;
		let pending = request.current ??= Api.repositories();
		pending.then(value => {
			if (active) setPage(value);
		}, reason => {
			if (active && !reauthenticate(reason)) setError(reason);
		});
		return () => {
			active = false;
		};
	}, [attempt, open, page]);

	useLayoutEffect(() => {
		if (!open) return;
		function place() {
			let rect = trigger.current?.getBoundingClientRect();
			if (!rect) return;
			let margin = 8;
			let gap = 4;
			let width = Math.max(0, Math.min(360, window.innerWidth - margin * 2));
			let left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
			let top = rect.bottom + gap;
			setPosition({
				left,
				maxHeight: Math.max(0, window.innerHeight - top - margin),
				top,
				visibility: "visible",
				width,
			});
		}

		place();
		window.addEventListener("resize", place);
		document.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			document.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		let frame = requestAnimationFrame(() => {
			if (!panel.current?.contains(document.activeElement)) search.current?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [open, page]);

	useEffect(() => {
		if (!open || !activeRepository) return;
		document.getElementById(optionId(listId, activeRepository))?.scrollIntoView({
			block: "nearest",
		});
	}, [activeRepository, listId, open]);

	useEffect(() => {
		if (!open) return;
		function closeOnPointer(event: PointerEvent) {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
			setOpen(false);
		}

		function closeOnFocus(event: FocusEvent) {
			let target = event.target;
			if (!(target instanceof Node)) return;
			if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
			setOpen(false);
		}

		function closeOnEscape(event: KeyboardEvent) {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			trigger.current?.focus();
		}

		document.addEventListener("pointerdown", closeOnPointer);
		document.addEventListener("focusin", closeOnFocus);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnPointer);
			document.removeEventListener("focusin", closeOnFocus);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);

	function retry() {
		request.current = undefined;
		setError(undefined);
		setAttempt(value => value + 1);
	}

	async function more() {
		if (!page?.nextPage || loadingMore) return;
		setLoadingMore(true);
		setError(undefined);
		try {
			let next = await Api.repositories(page.nextPage);
			if (!mounted.current) return;
			setPage(current => {
				let known = new Set(current?.repositories.map(repository => repository.id));
				return {
					repositories: [
						...(current?.repositories ?? []),
						...next.repositories.filter(repository => !known.has(repository.id)),
					],
					nextPage: next.nextPage,
				};
			});
		} catch (reason) {
			if (mounted.current && !reauthenticate(reason)) setError(reason);
		} finally {
			if (mounted.current) setLoadingMore(false);
		}
	}

	function select(repository: Api.Repository) {
		location.assign(repositoryHref(repository));
	}

	function searchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
		if (event.key === "ArrowDown") {
			setActive(value => matches.length === 0 ? 0 : (value + 1) % matches.length);
		} else if (event.key === "ArrowUp") {
			setActive(value => matches.length === 0 ? 0 : (value - 1 + matches.length) % matches.length);
		} else if (event.key === "Enter" && activeRepository) {
			select(activeRepository);
		} else {
			return;
		}
		event.preventDefault();
	}

	let popup = open && createPortal(
		<div
			className="fixed z-50 flex flex-col overflow-hidden rounded-lg bg-page ring-hairline shadow-overlay"
			id={panelId}
			ref={panel}
			style={position}
		>
			<div className="p-2 hairline-b">
				<label className="sr-only" htmlFor={`${listId}-search`}>Search repositories</label>
				<input
					aria-activedescendant={activeRepository ? optionId(listId, activeRepository) : undefined}
					aria-autocomplete="list"
					aria-controls={listId}
					aria-expanded="true"
					className="field h-8 w-full px-2 text-sm"
					id={`${listId}-search`}
					onChange={event => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={searchKeyDown}
					placeholder="Find a repository"
					ref={search}
					role="combobox"
					value={query}
				/>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto p-1" data-repository-scroll="">
				{!page && !error && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						Loading repositories...
					</p>
				)}
				{!page && error !== undefined && (
					<div className="px-2 py-3">
						<p className="text-sm text-destructive-ink" role="alert">
							Could not load repositories.
						</p>
						<button className="btn btn-sm btn-secondary mt-2" onClick={retry} type="button">
							Try again
						</button>
					</div>
				)}
				{page && repositories.length === 0 && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						No repositories available.
					</p>
				)}
				{page && repositories.length > 0 && matches.length === 0 && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						{page.nextPage ? "No matches in loaded repositories." : "No matching repositories."}
					</p>
				)}
				<div
					aria-busy={!page && error === undefined}
					aria-label="Repositories"
					id={listId}
					role="listbox"
				>
					{matches.map((repository, index) => {
						let selected = sameRepository(current, repository);
						return (
							<button
								aria-selected={selected}
								className={`flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left transition ${
									index === activeIndex ? "bg-selected" : "hover:bg-hover"
								}`}
								id={optionId(listId, repository)}
								key={repository.id}
								onClick={() => select(repository)}
								onMouseEnter={() => setActive(index)}
								role="option"
								tabIndex={-1}
								type="button"
							>
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-2">
										<span className="truncate text-sm font-medium">{repository.fullName}</span>
										{repository.private && (
											<span className="shrink-0 rounded-sm bg-inset px-1.5 text-sm text-text-tertiary">
												Private
											</span>
										)}
									</span>
									<span className="block text-sm text-text-tertiary">
										{repository.permissions.push || repository.permissions.admin
											? "Create and edit channels"
											: "View channels"}
									</span>
								</span>
								{selected && (
									<CheckIcon aria-hidden="true" className="shrink-0 text-brand-ink" size={16} />
								)}
							</button>
						);
					})}
				</div>
			</div>
			{page?.nextPage && (
				<div className="p-1 hairline-t">
					{error !== undefined && (
						<p className="px-2 py-1 text-sm text-destructive-ink" role="alert">
							Could not load more repositories.
						</p>
					)}
					<button
						className="btn btn-md btn-ghost w-full"
						disabled={loadingMore}
						onClick={() => void more()}
						type="button"
					>
						{loadingMore ? "Loading..." : error ? "Try loading more again" : "More repositories"}
					</button>
				</div>
			)}
		</div>,
		document.body,
	);

	return (
		<>
			<button
				aria-controls={panelId}
				aria-expanded={open}
				aria-haspopup="listbox"
				className="btn btn-sm btn-ghost min-w-0 max-w-40 shrink-0 gap-1.5 sm:max-w-64"
				onClick={() => setOpen(value => !value)}
				ref={trigger}
				type="button"
			>
				<span className="truncate">{current?.fullName ?? "Choose repository"}</span>
				<CaretDownIcon aria-hidden="true" className="shrink-0" size={14} />
			</button>
			{popup}
		</>
	);
}
