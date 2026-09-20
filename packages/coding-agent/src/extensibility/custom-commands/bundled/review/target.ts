import * as vcs from "@oh-my-pi/pi-natives/vcs";

import type { LocalReviewKind, ResolvedReviewTarget } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { parseReviewDiffSnapshot } from "@oh-my-pi/pi-tui/overlays/annotation-diff";

export interface ReviewTargetUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export const LOCAL_REVIEW_CHOICES: ReadonlyArray<{ label: string; kind: LocalReviewKind }> = [
	{ label: "1. Review against a base branch (PR Style)", kind: "base-branch" },
	{ label: "2. Review uncommitted changes", kind: "uncommitted" },
	{ label: "3. Review a specific commit", kind: "commit" },
];

export function createResolvedReviewTarget(
	kind: ResolvedReviewTarget["kind"],
	mode: string,
	rawDiff: string,
	emptyMessage: string,
	options: Pick<ResolvedReviewTarget, "filteredMessage" | "diffInstruction" | "contextInstruction"> = {},
): ResolvedReviewTarget {
	return {
		kind,
		mode,
		rawDiff,
		snapshot: parseReviewDiffSnapshot(rawDiff),
		emptyMessage,
		...options,
	};
}

export function createPrReviewTarget(
	mode: string,
	rawDiff: string,
	emptyMessage: string,
	options: Pick<ResolvedReviewTarget, "diffInstruction" | "contextInstruction"> = {},
): ResolvedReviewTarget {
	return createResolvedReviewTarget("pr", mode, rawDiff, emptyMessage, options);
}

export function getReviewTargetIssue(target: ResolvedReviewTarget): string | undefined {
	if (!target.rawDiff.trim()) return target.emptyMessage;
	if (target.snapshot.files.length === 0) {
		return target.filteredMessage ?? "No reviewable files (all changes filtered out)";
	}
	return undefined;
}

async function resolveUncommittedReviewTarget(
	cwd: string,
	ui: Pick<ReviewTargetUI, "notify">,
): Promise<ResolvedReviewTarget | undefined> {
	try {
		const repository = vcs.require(cwd);
		const diffText = await repository.uncommittedDiff([]);
		const isJj = repository.kind() === "jj";
		return createResolvedReviewTarget(
			"uncommitted",
			isJj ? "JJ working-copy changes" : "Uncommitted changes (staged + unstaged)",
			diffText,
			isJj || !diffText.trim() ? "No uncommitted changes found" : "No diff content found",
			{
				diffInstruction: isJj
					? "MUST run `jj --ignore-working-copy diff --git -- <path>` for assigned files"
					: "MUST run both `git diff -- <path>` and `git diff --cached -- <path>` for assigned files",
			},
		);
	} catch (error) {
		ui.notify(`Failed to get diff: ${error instanceof Error ? error.message : String(error)}`, "error");
		return undefined;
	}
}

export async function resolveLocalReviewTarget(
	kind: LocalReviewKind,
	cwd: string,
	ui: ReviewTargetUI,
): Promise<ResolvedReviewTarget | undefined> {
	switch (kind) {
		case "base-branch": {
			try {
				const git = vcs.requireGit(cwd);
				const branches = await git.listBranches(true);
				if (branches.length === 0) {
					ui.notify("No git branches found", "error");
					return undefined;
				}
				const baseBranch = await ui.select("Select base branch to compare against", branches);
				if (!baseBranch) return undefined;
				const currentBranch = (await git.currentBranch()) ?? "HEAD";
				const mergeBase = await git.mergeBase(baseBranch, currentBranch);
				if (!mergeBase) {
					ui.notify(`No common history between ${baseBranch} and ${currentBranch}`, "error");
					return undefined;
				}
				const diffText = await git.diffText({ base: mergeBase, head: currentBranch });
				return createResolvedReviewTarget(
					"base-branch",
					`Reviewing changes between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`,
					diffText,
					`No changes between ${baseBranch} and ${currentBranch}`,
				);
			} catch (error) {
				ui.notify(`Failed to get diff: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined;
			}
		}
		case "uncommitted":
			return resolveUncommittedReviewTarget(cwd, ui);
		case "commit": {
			try {
				const git = vcs.requireGit(cwd);
				const commits = await vcs.require(cwd).logOnelines(20);
				if (commits.length === 0) {
					ui.notify("No commits found", "error");
					return undefined;
				}
				const selectedCommit = await ui.select("Select commit to review", commits);
				if (!selectedCommit) return undefined;
				const hash = selectedCommit.split(" ")[0];
				if (!hash) {
					ui.notify("Selected commit is invalid", "error");
					return undefined;
				}
				const diffText = (await git.showCommit(hash)).data.toString("utf8");
				return createResolvedReviewTarget(
					"commit",
					`Reviewing commit \`${hash}\``,
					diffText,
					"Commit has no diff content",
					{ filteredMessage: "No reviewable files in commit (all changes filtered out)" },
				);
			} catch (error) {
				ui.notify(`Failed to get commit: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined;
			}
		}
	}
}
