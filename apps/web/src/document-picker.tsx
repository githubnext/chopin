import { CaretDownIcon, CheckIcon, PlusIcon } from "@phosphor-icons/react";
import { useTransitionPresence } from "@chopin/editor/transition-presence";
import { documentPath } from "@chopin/protocol/document-url";
import { createPortal } from "react-dom";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useAnchoredPicker } from "./anchored-picker";
import * as Api from "./api";
import { rememberChannel } from "./channel-recovery";
import { DocumentRename } from "./document-rename";
import { motionImmediately } from "./motion-input";

import type { KeyboardEvent as ReactKeyboardEvent } from "react";

function optionId(list: string, channel: Api.Channel): string {
	return `${list}-option-${channel.id}`;
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function select(
	userId: string,
	channel: Api.Channel,
	repository: Pick<Api.Repository, "owner" | "name" | "fullName">,
) {
	rememberChannel(userId, channel, repository);
	location.assign(documentPath(repository.owner, repository.name, channel.slug));
}

/** Repository-scoped navigation and creation stay separate from repository selection. */
export function DocumentPicker(
	{
		canEdit,
		current,
		onRename,
		repository,
		userId,
	}: {
		canEdit: boolean;
		current: Pick<Api.Channel, "id" | "title">;
		onRename: (channel: Pick<Api.Channel, "title" | "slug" | "updatedAt">) => void;
		repository: Pick<Api.Repository, "name" | "owner" | "fullName">;
		userId: string;
	},
) {
	let request = useRef(0);
	let panelId = useId();
	let listId = useId();
	let [open, setOpen] = useState(false);
	let [query, setQuery] = useState("");
	let [page, setPage] = useState<Api.ChannelPage>();
	let [listError, setListError] = useState<unknown>();
	let [createError, setCreateError] = useState<unknown>();
	let [creating, setCreating] = useState(false);
	let [renaming, setRenaming] = useState(false);
	let [renameError, setRenameError] = useState<unknown>();
	let [renameSaving, setRenameSaving] = useState(false);
	let [loadingMore, setLoadingMore] = useState(false);
	let [active, setActive] = useState(0);
	let [retry, setRetry] = useState(0);
	let normalized = query.trim();
	let channels = page?.channels ?? [];
	let activeIndex = channels.length === 0 ? -1 : Math.min(active, channels.length - 1);
	let activeChannel = channels[activeIndex];
	let pickerContent = useMemo(
		() => ({ channels: channels.length, createError, listError, renameError, renaming }),
		[channels.length, createError, listError, renameError, renaming],
	);
	let setPickerOpen = (next: boolean) => {
		if (!next && renameSaving) return;
		setOpen(next);
	};
	let { panel, position, search, trigger } = useAnchoredPicker(open, setPickerOpen, pickerContent);
	let popupPresence = useTransitionPresence(
		open ? true : undefined,
		150,
		motionImmediately(),
	);

	useEffect(() => {
		if (!open) return;
		let id = ++request.current;
		let timer = window.setTimeout(() => {
			setPage(undefined);
			setListError(undefined);
			Api.channels(repository.owner, repository.name, {
				includeArchived: false,
				query: normalized || undefined,
			}).then(value => {
				if (request.current !== id) return;
				setPage(value);
				setActive(0);
			}, reason => {
				if (request.current !== id) return;
				setListError(reason);
			});
		}, normalized ? 160 : 0);
		return () => window.clearTimeout(timer);
	}, [current.title, normalized, open, repository.name, repository.owner, retry]);

	useEffect(() => {
		if (!open || !activeChannel) return;
		let frame = requestAnimationFrame(() => {
			document.getElementById(optionId(listId, activeChannel))?.scrollIntoView({
				block: "nearest",
			});
		});
		return () => cancelAnimationFrame(frame);
	}, [activeChannel, listId, open]);

	function searchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
		if (event.key === "ArrowDown") {
			setActive(value => channels.length === 0 ? 0 : (value + 1) % channels.length);
		} else if (event.key === "ArrowUp") {
			setActive(value =>
				channels.length === 0 ? 0 : (value - 1 + channels.length) % channels.length
			);
		} else if (event.key === "Enter" && activeChannel) {
			select(userId, activeChannel, repository);
		} else return;
		event.preventDefault();
	}

	async function more() {
		if (!page?.nextCursor || loadingMore) return;
		let id = request.current;
		setLoadingMore(true);
		try {
			let next = await Api.channels(repository.owner, repository.name, {
				cursor: page.nextCursor,
				includeArchived: false,
				query: normalized || undefined,
			});
			if (request.current !== id) return;
			setPage(current =>
				current && {
					...next,
					channels: [
						...current.channels,
						...next.channels.filter(channel =>
							!current.channels.some(known => known.id === channel.id)
						),
					],
				}
			);
		} catch (reason) {
			if (request.current === id) setListError(reason);
		} finally {
			if (request.current === id) setLoadingMore(false);
		}
	}

	async function create() {
		if (creating) return;
		setCreating(true);
		setCreateError(undefined);
		try {
			let created = await Api.createChannel(repository.owner, repository.name);
			rememberChannel(userId, created.channel, created.repository);
			location.assign(documentPath(
				created.repository.owner,
				created.repository.name,
				created.channel.slug,
			));
		} catch (reason) {
			setCreateError(reason);
			setCreating(false);
		}
	}

	function finishRename(detail: Api.ChannelDetail) {
		onRename(detail.channel);
		setRenaming(false);
		setRenameError(undefined);
		setRenameSaving(false);
		setRetry(value => value + 1);
		requestAnimationFrame(() => search.current?.focus());
	}

	function cancelRename() {
		setRenaming(false);
		setRenameError(undefined);
		setRenameSaving(false);
		requestAnimationFrame(() => search.current?.focus());
	}

	let popup = popupPresence.phase !== "closed" && createPortal(
		<div
			aria-hidden={popupPresence.phase === "closing" ? "true" : undefined}
			className={`motion-dropdown ${popupPresence.className} fixed z-50 flex flex-col rounded-lg bg-page ring-hairline shadow-overlay`}
			id={panelId}
			inert={popupPresence.phase === "closing"}
			ref={panel}
			style={position}
		>
			<div className="p-2 hairline-b">
				<label className="sr-only" htmlFor={`${listId}-search`}>Search documents</label>
				<input
					aria-activedescendant={activeChannel ? optionId(listId, activeChannel) : undefined}
					aria-autocomplete="list"
					aria-controls={listId}
					aria-expanded={open}
					className="document-picker-search field h-8 w-full px-2 text-sm"
					id={`${listId}-search`}
					onChange={event => {
						setQuery(event.target.value);
						setActive(0);
					}}
					onKeyDown={searchKeyDown}
					placeholder="Find a document"
					ref={search}
					role="combobox"
					value={query}
				/>
			</div>
			<div
				className="min-h-0 overflow-y-auto p-1"
				data-document-scroll=""
				data-focus-boundary=""
				onScroll={event => {
					let node = event.currentTarget;
					if (node.scrollHeight - node.scrollTop - node.clientHeight < 32) void more();
				}}
				style={{ maxHeight: "min(60vh, 384px)" }}
			>
				{!page && !listError && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">Loading documents...</p>
				)}
				{listError !== undefined && (
					<div className="px-2 py-3">
						<p className="text-sm text-destructive-ink" role="alert">
							{message(listError, "Could not load documents.")}
						</p>
						<button
							className="btn btn-sm btn-secondary mt-2"
							disabled={creating}
							onClick={() => setRetry(value => value + 1)}
							type="button"
						>
							Try again
						</button>
					</div>
				)}
				{page && !listError && channels.length === 0 && (
					<p className="px-2 py-3 text-sm text-text-tertiary" role="status">
						No matching documents.
					</p>
				)}
				<div
					aria-label="Documents"
					aria-busy={!page && listError === undefined}
					id={listId}
					role="listbox"
				>
					{channels.map((channel, index) => {
						let selected = channel.id === current.id;
						let descriptionId = channel.description
							? `${optionId(listId, channel)}-description`
							: undefined;
						return (
							<button
								aria-describedby={descriptionId}
								aria-label={channel.title}
								aria-selected={selected}
								className={`flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left transition ${
									index === activeIndex ? "bg-selected" : "hover:bg-hover"
								}`}
								id={optionId(listId, channel)}
								key={channel.id}
								onClick={() => select(userId, channel, repository)}
								onMouseEnter={() => setActive(index)}
								role="option"
								tabIndex={-1}
								type="button"
							>
								<span className="min-w-0 flex-1 text-sm">
									<span className="block truncate font-medium">{channel.title}</span>
									{channel.description && (
										<span
											className="block truncate text-text-tertiary"
											id={descriptionId}
										>
											{channel.description}
										</span>
									)}
								</span>
								{selected && (
									<CheckIcon aria-hidden="true" className="shrink-0 text-brand-ink" size={16} />
								)}
							</button>
						);
					})}
				</div>
				{loadingMore && (
					<p className="px-2 py-2 text-sm text-text-tertiary" role="status">Loading...</p>
				)}
			</div>
			{canEdit && (
				<div className="p-1 hairline-t">
					{renaming
						? (
							<DocumentRename
								channel={current}
								className="p-2"
								onCancel={cancelRename}
								onErrorChange={setRenameError}
								onRenamed={finishRename}
								onSavingChange={setRenameSaving}
							/>
						)
						: (
							<>
								{createError !== undefined && (
									<p className="px-2 py-2 text-sm text-destructive-ink" role="alert">
										{message(createError, "Could not create document.")}
									</p>
								)}
								<button
									className="btn btn-md btn-ghost w-full justify-start"
									disabled={creating}
									onClick={() => setRenaming(true)}
									type="button"
								>
									Rename document
								</button>
								<button
									className="btn btn-md btn-ghost w-full justify-start"
									disabled={creating}
									onClick={() => void create()}
									type="button"
								>
									<PlusIcon aria-hidden="true" size={16} />
									<span className="ml-1">
										{creating ? "Creating..." : "Create new document"}
									</span>
								</button>
							</>
						)}
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
				aria-label={`Document: ${current.title}`}
				className="document-picker-trigger btn btn-sm btn-ghost min-w-0 max-w-64 justify-start gap-1 text-text-tertiary"
				onClick={() => setPickerOpen(!open)}
				ref={trigger}
				title={current.title}
				type="button"
			>
				<span className="truncate">{current.title}</span>
				<CaretDownIcon aria-hidden="true" className="shrink-0" size={14} />
			</button>
			{popup}
		</>
	);
}
