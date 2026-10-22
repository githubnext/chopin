import { ListView } from "@github-ui/list-view";
import { ListItem } from "@github-ui/list-view/ListItem";
import { ListItemDescription } from "@github-ui/list-view/ListItemDescription";
import { ListItemLeadingContent } from "@github-ui/list-view/ListItemLeadingContent";
import { ListItemLeadingVisual } from "@github-ui/list-view/ListItemLeadingVisual";
import { ListItemMainContent } from "@github-ui/list-view/ListItemMainContent";
import { ListItemMetadata } from "@github-ui/list-view/ListItemMetadata";
import { ListItemTitle } from "@github-ui/list-view/ListItemTitle";
import { CircleIcon, GitMergeIcon, GitPullRequestIcon, RocketIcon } from "@primer/octicons-react";
import { Label, Link, ProgressBar, Spinner } from "@primer/react";
import { Blankslate } from "@primer/react/experimental";
import { cue } from "./director";
import type { Task } from "./plans";
import styles from "./plans.module.css";
import { openDecisions, type PlanStore, usePlanState } from "./store";

let statusLabel: Record<
	Task["status"],
	{ text: string; variant: "secondary" | "attention" | "success" | "done" }
> = {
	drafted: { text: "Queued", variant: "secondary" },
	working: { text: "Copilot is coding", variant: "attention" },
	open: { text: "In review", variant: "success" },
	merged: { text: "Merged", variant: "done" },
};

function TaskVisual({ task }: { task: Task }) {
	if (task.status === "working") {
		return (
			<ListItemLeadingVisual description="In progress">
				<Spinner size="small" />
			</ListItemLeadingVisual>
		);
	}
	if (task.status === "open") {
		return (
			<ListItemLeadingVisual
				icon={GitPullRequestIcon}
				color="var(--fgColor-open)"
				description="Open"
			/>
		);
	}
	if (task.status === "merged") {
		return (
			<ListItemLeadingVisual icon={GitMergeIcon} color="var(--fgColor-done)" description="Merged" />
		);
	}
	return (
		<ListItemLeadingVisual icon={CircleIcon} color="var(--fgColor-muted)" description="Queued" />
	);
}

export function Build({ store }: { store: PlanStore }) {
	let state = usePlanState(store);
	let open = openDecisions(state);

	if (state.tasks.length === 0) {
		return (
			<Blankslate border spacious>
				<Blankslate.Visual>
					<RocketIcon size={24} />
				</Blankslate.Visual>
				<Blankslate.Heading>
					{state.status === "Building" ? "Planning the work" : "Build this plan"}
				</Blankslate.Heading>
				<Blankslate.Description>
					{open > 0
						? `Resolve ${open} open ${open === 1 ? "decision" : "decisions"} before building.`
						: "Copilot splits the plan into tasks and opens a pull request for each one."}
				</Blankslate.Description>
				{state.status !== "Building" && (
					<Blankslate.PrimaryAction
						disabled={open > 0}
						onClick={() => cue("build")}
					>
						Build plan
					</Blankslate.PrimaryAction>
				)}
			</Blankslate>
		);
	}

	let shipped = state.tasks.filter(task => task.status === "merged").length;
	let reviewed =
		state.tasks.filter(task => task.status === "open" || task.status === "merged").length;

	return (
		<div className={styles.build}>
			<div className={styles.buildSummary}>
				<span>
					<strong>{reviewed}</strong> of {state.tasks.length} pull requests opened,{" "}
					<strong>{shipped}</strong> merged
				</span>
				<ProgressBar
					aria-label="Plan progress"
					barSize="small"
					progress={Math.round(((reviewed + shipped) / (state.tasks.length * 2)) * 100)}
				/>
			</div>
			<ListView title="Tasks">
				{state.tasks.map(task => (
					<ListItem
						key={task.id}
						title={<ListItemTitle value={task.title} />}
						metadata={[
							<ListItemMetadata key="status">
								<Label variant={statusLabel[task.status].variant}>
									{statusLabel[task.status].text}
								</Label>
							</ListItemMetadata>,
							<ListItemMetadata key="pr">
								{task.pr && (task.status === "open" || task.status === "merged")
									? <Link href="/monalisa/smile/pulls">#{task.pr}</Link>
									: null}
							</ListItemMetadata>,
						]}
					>
						<ListItemLeadingContent>
							<TaskVisual task={task} />
						</ListItemLeadingContent>
						<ListItemMainContent>
							<ListItemDescription>{task.detail}</ListItemDescription>
						</ListItemMainContent>
					</ListItem>
				))}
			</ListView>
		</div>
	);
}
