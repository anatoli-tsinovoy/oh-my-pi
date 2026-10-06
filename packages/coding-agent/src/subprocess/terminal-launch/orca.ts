import { quotePosixArgument, quotePosixArgv } from "../../utils/shell-quote";
import { launchError, nestedString, parseJson, runStep } from "./shared";
import type { TerminalLaunchBackend, TerminalLaunchCliRunner, TerminalLaunchRequest } from "./types";

function orcaEnvelope(request: TerminalLaunchRequest, operation: string, stdout: string): Record<string, unknown> {
	const payload = parseJson(request, operation, stdout);
	if (payload.ok !== true) {
		throw launchError(request, operation, `Orca ${operation} returned an unsuccessful response.`);
	}
	return payload;
}

function requiredHandle(
	request: TerminalLaunchRequest,
	operation: string,
	payload: Record<string, unknown>,
	...path: string[]
): string {
	const handle = nestedString(payload, ...path);
	if (!handle) throw launchError(request, operation, `Orca ${operation} returned no terminal handle.`);
	return handle;
}

function terminalIdentityPart(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

async function resolvePaneHandle(
	request: Extract<TerminalLaunchRequest, { multiplexer: "orca"; placement: "pane" }>,
	cli: string,
	environment: NodeJS.ProcessEnv,
	runCli: TerminalLaunchCliRunner,
): Promise<string> {
	const paneKey = environment.ORCA_PANE_KEY;
	const worktreeId = environment.ORCA_WORKTREE_ID;
	if (!paneKey || !worktreeId) {
		throw launchError(
			request,
			"target",
			"Orca pane launch requires ORCA_PANE_KEY and ORCA_WORKTREE_ID or an explicit terminal handle.",
		);
	}

	// Orca limits terminal.list by default; a missing pane in the first page is not proof it exited.
	const list = async (limit?: number) => {
		const argv = [cli, "terminal", "list", "--worktree", `id:${worktreeId}`];
		if (limit !== undefined) argv.push("--limit", String(limit));
		argv.push("--json");
		const payload = orcaEnvelope(
			request,
			"terminal list",
			await runStep(request, "terminal list", argv, request.cwd, runCli),
		);
		const result = payload.result;
		if (
			typeof result !== "object" ||
			result === null ||
			Array.isArray(result) ||
			!("terminals" in result) ||
			!Array.isArray(result.terminals) ||
			!("truncated" in result) ||
			typeof result.truncated !== "boolean" ||
			!("totalCount" in result) ||
			typeof result.totalCount !== "number" ||
			!Number.isSafeInteger(result.totalCount) ||
			result.totalCount < result.terminals.length
		) {
			throw launchError(request, "terminal list", "Orca terminal list did not report valid listing completeness.");
		}
		return { terminals: result.terminals, truncated: result.truncated, totalCount: result.totalCount };
	};
	const first = await list();
	const listing = first.truncated ? await list(first.totalCount) : first;
	if (listing.truncated || listing.terminals.length !== listing.totalCount) {
		throw launchError(
			request,
			"terminal list",
			"Orca terminal list changed during resolution; provide a terminal handle.",
		);
	}
	const matches: string[] = [];
	for (const terminal of listing.terminals) {
		if (
			typeof terminal !== "object" ||
			terminal === null ||
			Array.isArray(terminal) ||
			!("handle" in terminal) ||
			!("worktreeId" in terminal) ||
			!("tabId" in terminal) ||
			!("leafId" in terminal)
		) {
			throw launchError(request, "terminal list", "Orca terminal list returned invalid terminal information.");
		}
		const handle = terminal.handle;
		const terminalWorktreeId = terminalIdentityPart(terminal.worktreeId);
		const tabId = terminalIdentityPart(terminal.tabId);
		const leafId = terminalIdentityPart(terminal.leafId);
		if (typeof handle !== "string" || !handle.trim() || !terminalWorktreeId || !tabId || !leafId) {
			throw launchError(request, "terminal list", "Orca terminal list returned invalid terminal information.");
		}
		if (terminalWorktreeId === worktreeId && `${tabId}:${leafId}` === paneKey) matches.push(handle);
	}
	const [match, duplicate] = matches;
	if (!match || duplicate) {
		throw launchError(
			request,
			"target",
			matches.length === 0
				? "Orca could not resolve ORCA_PANE_KEY to a terminal handle."
				: "Orca resolved ORCA_PANE_KEY to multiple terminal handles.",
		);
	}
	return match;
}

export const launchOrca: TerminalLaunchBackend<"orca"> = async (request, { environment, runCli }) => {
	const cli = process.platform === "linux" ? "orca-ide" : "orca";
	const shellCommand = `cd ${quotePosixArgument(request.cwd)} && ${quotePosixArgv(request.command)}`;

	if (request.placement === "pane") {
		const target = request.target ?? (await resolvePaneHandle(request, cli, environment, runCli));
		const direction = request.direction === "down" ? "vertical" : "horizontal";
		const argv = [
			cli,
			"terminal",
			"split",
			"--terminal",
			target,
			"--direction",
			direction,
			"--command",
			shellCommand,
			"--json",
		];
		const output = await runStep(request, "terminal split", argv, request.cwd, runCli);
		const payload = orcaEnvelope(request, "terminal split", output);
		return {
			multiplexer: "orca",
			placement: "pane",
			id: requiredHandle(request, "terminal split", payload, "result", "split", "handle"),
		};
	}

	const worktree = request.target ?? (environment.ORCA_WORKTREE_ID ? `id:${environment.ORCA_WORKTREE_ID}` : undefined);
	if (!worktree) {
		throw launchError(request, "target", "Orca terminal creation requires a worktree selector or ORCA_WORKTREE_ID.");
	}
	const argv = [cli, "terminal", "create", "--worktree", worktree];
	if (request.name) argv.push("--title", request.name);
	if (request.focus === true) argv.push("--focus");
	argv.push("--command", shellCommand, "--json");
	const output = await runStep(request, "terminal create", argv, request.cwd, runCli);
	const payload = orcaEnvelope(request, "terminal create", output);
	return {
		multiplexer: "orca",
		placement: "window",
		id: requiredHandle(request, "terminal create", payload, "result", "terminal", "handle"),
	};
};
