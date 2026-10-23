import type { RepositoryPageProps } from "@github-ui/playground/repository";
import {
	Link,
	SoftNavOnlyLink,
	useLinkClickHandler,
	useLocation,
	useNavigationType,
	useSearchParams,
} from "@github-ui/react-router";
import { ThreePanesLayout } from "@github-ui/three-panes-layout";
import { CheckCircleIcon, CommentDiscussionIcon } from "@primer/octicons-react";
import PlansIcon from "./plans-icon";
import {
	Avatar,
	AvatarStack,
	Button,
	CounterLabel,
	Label,
	NavList,
	SegmentedControl,
} from "@primer/react";
import { Blankslate, type Column, DataTable, Table } from "@primer/react/experimental";
import { type ReactNode, useEffect } from "react";
import { Face } from "./conversation";
import { resumeTour } from "./director";
import { PlanView, statusVariant } from "./plan-view";
import { avatarUrl, type Decision, displayName, type Plan, planPath, plans } from "./plans";
import styles from "./plans.module.css";
import { openDecisions, type PlanState, type Tab, useAllPlans } from "./store";

type View = "plans" | "decisions";

type PlanEntry = { id: string; plan: Plan; state: PlanState };

function planColumns(): Column<PlanEntry>[] {
	return [
		{
			header: "Plan",
			field: "plan.title",
			rowHeader: true,
			width: "growCollapse",
			minWidth: 190,
			renderCell: ({ plan }) => (
				<span className={styles.titleCell}>
					<PlansIcon className={styles.planIcon} aria-hidden />
					<span>
						<Link to={planPath(plan)} className={styles.titleLink}>
							{plan.title}
						</Link>{" "}
						<span className={styles.planNumber}>#{plan.number}</span>
					</span>
				</span>
			),
		},
		{
			header: "Status",
			field: "state.status",
			width: "auto",
			renderCell: ({ state }) => <Label variant={statusVariant[state.status]}>{state.status}
			</Label>,
		},
		{
			header: "Decisions",
			id: "decisions",
			width: "auto",
			align: "end",
			renderCell: ({ plan, state }) => {
				let open = openDecisions(state);
				return open > 0
					? (
						<Link to={planPath(plan, "decisions")} className={styles.countLink}>
							<CommentDiscussionIcon size={16} />
							{open}
						</Link>
					)
					: <span className={styles.mutedCell}>None</span>;
			},
		},
		{
			header: "People",
			id: "collaborators",
			width: "auto",
			renderCell: ({ plan }) => (
				<AvatarStack size={20}>
					{plan.collaborators.map(login => (
						<Avatar key={login} src={avatarUrl(login)} alt={displayName(login)} />
					))}
				</AvatarStack>
			),
		},
		{
			header: "Last edited",
			field: "state.updated",
			width: "auto",
			renderCell: ({ state }) => (
				<span className={styles.personCell}>
					<Face login={state.updatedBy} size={20} />
					<span className={styles.stacked}>
						{displayName(state.updatedBy)}
						<span className={styles.mutedCell}>{state.updated}</span>
					</span>
				</span>
			),
		},
	];
}

type DecisionEntry = { id: string; plan: Plan; decision: Decision };

function decisionColumns(): Column<DecisionEntry>[] {
	return [
		{
			header: "Decision",
			field: "decision.question",
			rowHeader: true,
			width: "growCollapse",
			minWidth: 190,
			renderCell: ({ plan, decision }) => {
				let open = decision.answer === null;
				return (
					<span className={styles.titleCell}>
						{open
							? <CommentDiscussionIcon className={styles.openIcon} aria-label="Open" />
							: <CheckCircleIcon className={styles.doneIcon} aria-label="Made" />}
						<Link
							to={planPath(plan, "decisions")}
							className={styles.titleLink}
						>
							{decision.question}
						</Link>
					</span>
				);
			},
		},
		{
			header: "Plan",
			field: "plan.title",
			width: "growCollapse",
			minWidth: 120,
			renderCell: ({ plan }) => (
				<Link to={planPath(plan)} className={styles.planCell}>
					{plan.title} <span className={styles.planNumber}>#{plan.number}</span>
				</Link>
			),
		},
		{
			header: "Outcome",
			field: "decision.answer",
			width: "auto",
			renderCell: ({ decision }) => {
				let chosen = decision.options.find(option => option.id === decision.answer);
				if (!chosen) return <Label variant="attention">Awaiting answer</Label>;
				return (
					<span className={styles.stacked}>
						<span>
							<Label variant="success">{chosen.label}</Label>
						</span>
						{decision.answeredBy && (
							<span className={styles.mutedCell}>by {displayName(decision.answeredBy)}</span>
						)}
					</span>
				);
			},
		},
		{
			header: "Raised",
			field: "decision.raisedAt",
			width: "auto",
			renderCell: ({ decision }) => (
				<span className={styles.personCell}>
					<Face login={decision.raisedBy} size={20} />
					<span className={styles.stacked}>
						{displayName(decision.raisedBy)}
						<span className={styles.mutedCell}>{decision.raisedAt}</span>
					</span>
				</span>
			),
		},
	];
}

function Header({ title, action }: { title: string; action?: ReactNode }) {
	return (
		<div className={styles.listHeader}>
			<h1 className={styles.listTitle}>{title}</h1>
			{action}
		</div>
	);
}

resumeTour();

export default function PlansPage({ owner, name }: RepositoryPageProps) {
	let [params] = useSearchParams();
	// Plans are addressed by number beneath the page, as `/owner/repo/plans/4`.
	let number = useLocation().pathname.split("/").slice(4).filter(Boolean).join("/");
	let base = `/${owner}/${name}/plans`;
	// github-ui's Link and useNavigate fall back to a Turbo frame visit for routes a partial does not
	// own, which remounts the page and flashes the footer. Switching views stays client-side and
	// replaces the entry, because Turbo reloads any pushed entry on back and forward.
	let showOpen = useLinkClickHandler<HTMLButtonElement>(`${base}?view=decisions`, {
		replace: true,
	});
	let showMadeOnly = useLinkClickHandler<HTMLButtonElement>(
		`${base}?view=decisions&state=made`,
		{ replace: true },
	);
	let all = useAllPlans();
	// Turbo files the outgoing page's snapshot under the last URL it rendered, and the playground
	// reloads any back or forward that finds none. Follow client-side view switches, but not pops,
	// where Turbo is still caching the page being left.
	let navigationType = useNavigationType();
	let search = params.toString();
	useEffect(() => {
		if (navigationType === "POP") return;
		let turbo = (window as { Turbo?: { session: { view: { lastRenderedLocation: URL } } } })
			.Turbo;
		if (turbo) turbo.session.view.lastRenderedLocation = new URL(window.location.href);
	}, [navigationType, search]);
	let selected = plans.find(plan => String(plan.number) === number);
	let view: View = params.get("view") === "decisions" ? "decisions" : "plans";
	let tab = params.get("tab");

	if (selected) {
		return (
			<PlanView
				key={selected.slug}
				plan={selected}
				initialTab={tab === "decisions" || tab === "build" ? (tab as Tab) : undefined}
			/>
		);
	}

	let decisions = all.flatMap(({ plan, state }) =>
		state.decisions.map(decision => ({ plan, decision }))
	);
	let openCount = decisions.filter(({ decision }) => decision.answer === null).length;
	let showMade = params.get("state") === "made";
	let shown: DecisionEntry[] = decisions
		.filter(({ decision }) => (decision.answer !== null) === showMade)
		.map(({ plan, decision }) => ({ id: `${plan.slug}/${decision.id}`, plan, decision }));

	let sidebar = (
		<NavList aria-label="Plans" className={styles.sidebar}>
			<NavList.Item
				as={SoftNavOnlyLink}
				to={base}
				replace
				aria-current={view === "plans" ? "page" : undefined}
			>
				<NavList.LeadingVisual>
					<PlansIcon />
				</NavList.LeadingVisual>
				Plans
			</NavList.Item>
			<NavList.Item
				as={SoftNavOnlyLink}
				to={`${base}?view=decisions`}
				replace
				aria-current={view === "decisions" ? "page" : undefined}
			>
				<NavList.LeadingVisual>
					<CommentDiscussionIcon />
				</NavList.LeadingVisual>
				Decisions
				{openCount > 0 && (
					<NavList.TrailingVisual>
						<CounterLabel>{openCount}</CounterLabel>
					</NavList.TrailingVisual>
				)}
			</NavList.Item>
		</NavList>
	);

	let content = view === "decisions"
		? (
			<div className={styles.listPane}>
				<Header title="Decisions" />
				<Table.Container className={styles.tableContainer}>
					<Table.Title as="h2" id="decisions-table">
						{showMade ? "Made" : "Open"} decisions
					</Table.Title>
					<Table.Actions>
						<SegmentedControl
							aria-label="Decision state"
							size="small"
						>
							<SegmentedControl.Button selected={!showMade} count={openCount} onClick={showOpen}>
								Open
							</SegmentedControl.Button>
							<SegmentedControl.Button
								selected={showMade}
								count={decisions.length - openCount}
								onClick={showMadeOnly}
							>
								Made
							</SegmentedControl.Button>
						</SegmentedControl>
					</Table.Actions>
					{shown.length > 0
						? (
							<DataTable
								aria-labelledby="decisions-table"
								data={shown}
								columns={decisionColumns()}
								cellPadding="spacious"
							/>
						)
						: (
							<div className={styles.tableEmpty}>
								<Blankslate border>
									<Blankslate.Visual>
										<CommentDiscussionIcon size="medium" />
									</Blankslate.Visual>
									<Blankslate.Heading>
										{showMade ? "No decisions made yet" : "No open decisions"}
									</Blankslate.Heading>
									<Blankslate.Description>
										Copilot raises a decision when a plan needs a choice only a person can make.
									</Blankslate.Description>
								</Blankslate>
							</div>
						)}
				</Table.Container>
			</div>
		)
		: (
			<div className={styles.listPane}>
				<Header title="Plans" action={<Button variant="primary">New plan</Button>} />
				{number && (
					<Blankslate border narrow>
						<Blankslate.Heading>Plan not found</Blankslate.Heading>
						<Blankslate.Description>
							No plan #{number} exists in this repository.
						</Blankslate.Description>
					</Blankslate>
				)}
				<Table.Container className={styles.tableContainer}>
					<Table.Title as="h2" id="plans-table">
						All plans
					</Table.Title>
					<DataTable
						aria-labelledby="plans-table"
						data={all.map(({ plan, state }) => ({ id: plan.slug, plan, state }))}
						columns={planColumns()}
						cellPadding="spacious"
					/>
				</Table.Container>
			</div>
		);

	return (
		<ThreePanesLayout
			leftPane={{ element: sidebar, ariaLabel: "Plans navigation" }}
			leftPaneWidth="medium"
			resizeable={false}
			contentAs="div"
			middlePane={content}
		/>
	);
}
