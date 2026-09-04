/** Whether the process is running inside a tmux session. */
export function isInsideTmux(env: NodeJS.ProcessEnv = Bun.env): boolean {
	return Boolean(env.TMUX);
}


/** Wrap a control sequence in one or more nested tmux passthrough envelopes. */
export function wrapTmuxPassthrough(payload: string, depth = 1): string {
	let wrapped = payload;
	for (let i = 0; i < depth; i++) wrapped = `\x1bPtmux;${wrapped.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
	return wrapped;
}

let cachedTmuxClientKey: string | undefined;
let cachedTmuxPassthroughDepth = 1;

function tmuxPassthroughDepth(env: NodeJS.ProcessEnv): number {
	const override = Number.parseInt(env.OMP_TMUX_PASSTHROUGH_DEPTH ?? "", 10);
	if (override >= 1 && override <= 8) return override;
	if (env !== Bun.env) return 1;

	const key = `${env.TMUX ?? ""}|${env.TMUX_PANE ?? ""}`;
	if (key === cachedTmuxClientKey) return cachedTmuxPassthroughDepth;
	cachedTmuxClientKey = key;
	cachedTmuxPassthroughDepth = 1;

	const query = Bun.spawnSync(["tmux", "display-message", "-p", "#{client_termname}"], {
		stdout: "pipe",
		stderr: "ignore",
	});
	if (query.exitCode === 0) {
		const clientTerm = query.stdout.toString().trim().toLowerCase();
		if (clientTerm.startsWith("tmux") || clientTerm.startsWith("screen")) cachedTmuxPassthroughDepth = 2;
	}
	return cachedTmuxPassthroughDepth;
}

/** Pass a control sequence through every detected tmux layer. */
export function wrapTmuxPassthroughIfNeeded(payload: string, env: NodeJS.ProcessEnv = Bun.env): string {
	return isInsideTmux(env) ? wrapTmuxPassthrough(payload, tmuxPassthroughDepth(env)) : payload;
}
