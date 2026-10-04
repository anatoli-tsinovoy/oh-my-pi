export const orcaMultiplexer = {
	isInside(env: NodeJS.ProcessEnv = Bun.env): boolean {
		return Boolean(env.ORCA_PANE_KEY?.trim() && env.ORCA_WORKTREE_ID?.trim());
	},
};
