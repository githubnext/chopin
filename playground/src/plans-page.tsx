import type { RepositoryPageProps } from "@github-ui/playground/repository";
import { ListView } from "@github-ui/list-view";
import { ListItem } from "@github-ui/list-view/ListItem";
import { ListItemDescription } from "@github-ui/list-view/ListItemDescription";
import { ListItemLeadingContent } from "@github-ui/list-view/ListItemLeadingContent";
import { ListItemLeadingVisual } from "@github-ui/list-view/ListItemLeadingVisual";
import { ListItemMainContent } from "@github-ui/list-view/ListItemMainContent";
import { ListItemMetadata } from "@github-ui/list-view/ListItemMetadata";
import { ListItemTitle } from "@github-ui/list-view/ListItemTitle";
import { useSearchParams } from "@github-ui/react-router";
import { CommentDiscussionIcon } from "@primer/octicons-react";
import PlansIcon from "./plans-icon";
import { Avatar, AvatarStack, Button, Label } from "@primer/react";
import { Blankslate } from "@primer/react/experimental";
import { PlanView, statusVariant } from "./plan-view";
import { avatarUrl, findPlan, type Plan, plans } from "./plans";
import styles from "./plans.module.css";
import { openDecisions, planStore, usePlanState } from "./store";

function PlanRow({ plan, base }: { plan: Plan; base: string }) {
	let state = usePlanState(planStore(plan.slug));
	let open = openDecisions(state);
	return (
		<ListItem
			title={<ListItemTitle value={plan.title} href={`${base}?plan=${plan.slug}`} />}
			metadata={[
				<ListItemMetadata key="decisions">
					{open > 0 && (
						<span className={styles.metaCount} aria-label={`${open} open decisions`}>
							<CommentDiscussionIcon size={16} />
							{open}
						</span>
					)}
				</ListItemMetadata>,
				<ListItemMetadata key="people">
					<AvatarStack size={20} alignRight>
						{plan.collaborators.map(login => (
							<Avatar key={login} src={avatarUrl(login)} alt={login} />
						))}
					</AvatarStack>
				</ListItemMetadata>,
			]}
		>
			<ListItemLeadingContent>
				<ListItemLeadingVisual icon={PlansIcon} color="var(--fgColor-muted)" description="Plan" />
			</ListItemLeadingContent>
			<ListItemMainContent>
				<ListItemDescription>
					<Label variant={statusVariant[state.status]}>{state.status}</Label> #{plan.number}{" "}
					· Edited {state.updated} by {state.updatedBy}
				</ListItemDescription>
			</ListItemMainContent>
		</ListItem>
	);
}

export default function PlansPage({ owner, name }: RepositoryPageProps) {
	let [params] = useSearchParams();
	let base = `/${owner}/${name}/plans`;
	let slug = params.get("plan");
	let selected = findPlan(slug);

	if (selected) return <PlanView key={selected.slug} plan={selected} />;

	return (
		<div className={styles.page}>
			<div className={styles.listHeader}>
				<h1 className={styles.listTitle}>Plans</h1>
				<Button variant="primary">New plan</Button>
			</div>
			{slug && (
				<Blankslate border narrow>
					<Blankslate.Heading>Plan not found</Blankslate.Heading>
					<Blankslate.Description>
						No plan named “{slug}” exists in this repository.
					</Blankslate.Description>
				</Blankslate>
			)}
			<ListView title="Plans">
				{plans.map(plan => <PlanRow key={plan.slug} plan={plan} base={base} />)}
			</ListView>
		</div>
	);
}
