import { ptree } from "@oh-my-pi/pi-utils";
import { isInsideHerdr } from "@oh-my-pi/pi-tui/terminal-multiplexer";

export type TerminalLaunchMultiplexer = "tmux" | "zellij" | "herdr" | "cmux";
export type TerminalLaunchPlacement = "pane" | "window";

type LaunchFields<Placement extends TerminalLaunchPlacement> = {
	placement: Placement;
	command: readonly string[];
	cwd: string;
	/** A provider-native pane, tab, workspace, window, or session ID/ref; meaning varies by backend and placement. */
	target?: string;
	/** Focus behavior is provider-specific. Some backends reject explicit values they cannot honor. */
	focus?: boolean;
};

/**
 * Command options for a terminal multiplexer. `window` means a multiplexer
 * group (tmux window, Zellij/Herdr tab, or CMUX workspace), never an OS window.
 */
export type TerminalLaunchRequest =
	| (LaunchFields<"pane"> & {
			multiplexer: "tmux";
			execution?: "direct" | "shell";
			direction?: "right" | "down";
	  })
	/** For tmux `window`, `target` is a session ID/name; omit it for the current session. */
	| (LaunchFields<"window"> & {
			multiplexer: "tmux";
			execution?: "direct" | "shell";
	  })
	| (LaunchFields<"pane"> & {
			multiplexer: "zellij";
			execution?: "direct";
			direction?: "right" | "down";
			floating?: boolean;
			name?: string;
	  })
	| (LaunchFields<"window"> & {
			multiplexer: "zellij";
			execution?: "direct";
			name?: string;
	  })
	| (LaunchFields<"pane"> & {
			multiplexer: "herdr";
			execution?: "shell-input";
			direction?: "right" | "down";
	  })
	| (LaunchFields<"window"> & {
			multiplexer: "herdr";
			execution?: "shell-input";
			label?: string;
	  })
	| (LaunchFields<"pane"> & {
			multiplexer: "cmux";
			execution?: "shell-input";
			direction?: "right" | "left" | "up" | "down";
	  })
	| (LaunchFields<"window"> & {
			multiplexer: "cmux";
			execution?: "shell-input";
			name?: string;
	  });

export interface TerminalLaunchResult {
	multiplexer: TerminalLaunchMultiplexer;
	placement: TerminalLaunchPlacement;
	/** Provider-native ID when the CLI reports one (pane ID or multiplexer group ID). */
	id?: string;
}

export interface TerminalLaunchCliResult {
	stdout: string;
	exitCode: number | null;
}

/** Receives the exact argv dispatched to a backend CLI and its process cwd. */
export type TerminalLaunchCliRunner = (argv: readonly string[], cwd: string) => Promise<TerminalLaunchCliResult>;

/** Sanitized launch failure. Messages deliberately omit command argv, stdout, and stderr. */
export class TerminalLaunchError extends Error {
	constructor(
		message: string,
		public readonly multiplexer: TerminalLaunchMultiplexer,
		public readonly placement: TerminalLaunchPlacement,
		public readonly operation: string,
		public readonly exitCode?: number | null,
	) {
		super(message);
		this.name = "TerminalLaunchError";
	}
}

/** @internal Dependency seam for deterministic CLI behavior tests. */
export interface TerminalLaunchDependencies {
	environment?: () => NodeJS.ProcessEnv;
	runCli?: TerminalLaunchCliRunner;
}

const processCli: TerminalLaunchCliRunner = async (argv, cwd) => {
	const result = await ptree.exec([...argv], { cwd, allowNonZero: true });
	return { stdout: result.stdout, exitCode: result.exitCode };
};

function quotePosixArgument(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function quotePosixArgv(argv: readonly string[]): string {
	return argv.map(quotePosixArgument).join(" ");
}

function launchError(
	request: TerminalLaunchRequest,
	operation: string,
	message: string,
	exitCode?: number | null,
): TerminalLaunchError {
	return new TerminalLaunchError(message, request.multiplexer, request.placement, operation, exitCode);
}

function validateRequest(request: TerminalLaunchRequest): void {
	if (!Array.isArray(request.command) || request.command.length === 0) {
		throw launchError(request, "validate", "A terminal launch requires a non-empty command.");
	}
	if (request.command.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
		throw launchError(request, "validate", "A terminal launch command contains an invalid argument.");
	}
	if (typeof request.cwd !== "string" || request.cwd.length === 0 || request.cwd.includes("\0")) {
		throw launchError(request, "validate", "A terminal launch requires a valid working directory.");
	}
	if (
		request.target !== undefined &&
		(typeof request.target !== "string" || request.target.length === 0 || request.target.includes("\0"))
	) {
		throw launchError(request, "validate", "The terminal launch target is invalid.");
	}
	if (
		request.multiplexer === "tmux" &&
		request.placement === "window" &&
		request.target &&
		/^[%@]/u.test(request.target)
	) {
		throw launchError(
			request,
			"target",
			"tmux new-window target must be a session ID or name, not a pane or window ID.",
		);
	}
	if (request.execution !== undefined) {
		const supported =
			request.multiplexer === "tmux"
				? request.execution === "direct" || request.execution === "shell"
				: request.multiplexer === "zellij"
					? request.execution === "direct"
					: request.execution === "shell-input";
		if (!supported) {
			throw launchError(request, "options", "The requested execution mode is not supported by this multiplexer.");
		}
	}
}

function requireCapability(request: TerminalLaunchRequest, env: NodeJS.ProcessEnv): void {
	switch (request.multiplexer) {
		case "tmux":
			if (!env.TMUX && !request.target) {
				throw launchError(
					request,
					"capability",
					"tmux launch requires an active TMUX session or an explicit target.",
				);
			}
			if (request.placement === "pane" && !(request.target ?? (env.TMUX ? env.TMUX_PANE : undefined))) {
				throw launchError(request, "target", "tmux split-window requires a target pane ID or TMUX_PANE.");
			}
			return;
		case "zellij":
			if (!env.ZELLIJ) throw launchError(request, "capability", "zellij launch requires an active ZELLIJ session.");
			return;
		case "herdr":
			if (!isInsideHerdr(env))
				throw launchError(request, "capability", "herdr launch requires an active Herdr pane or workspace.");
			return;
		case "cmux":
			// CMUX_SOCKET_PATH and CMUX_REMOTE_TRANSPORT alone can exist outside a
			// live local workspace. A provider-native target can also identify the
			// exact surface/window the CLI must address.
			if (!env.CMUX_WORKSPACE_ID && !env.CMUX_SURFACE_ID && !request.target) {
				throw launchError(request, "capability", "cmux launch requires a CMUX context or explicit target ID.");
			}
			return;
	}
}

async function runStep(
	request: TerminalLaunchRequest,
	operation: string,
	argv: readonly string[],
	cwd: string,
	runCli: TerminalLaunchCliRunner,
): Promise<string> {
	let result: TerminalLaunchCliResult;
	try {
		result = await runCli(argv, cwd);
	} catch {
		throw launchError(request, operation, `${request.multiplexer} ${operation} could not start its CLI.`);
	}
	if (result.exitCode !== 0) {
		const exit = result.exitCode === null ? "did not exit successfully" : `failed (exit ${result.exitCode})`;
		throw launchError(request, operation, `${request.multiplexer} ${operation} ${exit}.`, result.exitCode);
	}
	return result.stdout;
}

function oneLineId(request: TerminalLaunchRequest, operation: string, stdout: string): string {
	const trimmed = stdout.trim();
	if (!trimmed || /[\r\n]/.test(trimmed)) {
		throw launchError(request, operation, `${request.multiplexer} ${operation} did not return a valid ID.`);
	}
	return trimmed;
}

function parseJson(request: TerminalLaunchRequest, operation: string, stdout: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(stdout);
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
		return value as Record<string, unknown>;
	} catch {
		throw launchError(request, operation, `${request.multiplexer} ${operation} returned invalid JSON.`);
	}
}

function nestedString(value: unknown, ...keys: string[]): string | undefined {
	let current: unknown = value;
	for (const key of keys) {
		if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" && current.trim() ? current : undefined;
}

function cmuxPayload(value: Record<string, unknown>): Record<string, unknown> {
	if (value.ok === false) return value;
	const data = value.data;
	return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : value;
}

function cmuxId(value: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const id = value[key];
		if ((typeof id === "string" && id.trim()) || (typeof id === "number" && Number.isFinite(id))) return String(id);
	}
	return undefined;
}

async function launchTmux(
	request: Extract<TerminalLaunchRequest, { multiplexer: "tmux" }>,
	env: NodeJS.ProcessEnv,
	runCli: TerminalLaunchCliRunner,
): Promise<TerminalLaunchResult> {
	const operation = request.placement === "pane" ? "split-window" : "new-window";
	let target: string | undefined;
	if (request.placement === "pane") {
		target = request.target ?? env.TMUX_PANE;
		if (!target) throw launchError(request, "target", "tmux split-window requires a target pane ID or TMUX_PANE.");
	} else {
		target = request.target;
	}
	const argv = ["tmux", operation];
	if (request.placement === "pane") argv.push(request.direction === "down" ? "-v" : "-h");
	if (request.focus === false) argv.push("-d");
	argv.push("-c", request.cwd);
	if (target) argv.push("-t", target);
	argv.push("-P", "-F", request.placement === "pane" ? "#{pane_id}" : "#{window_id}", "--");
	let commandArgs: readonly string[];
	if (request.execution === "shell") {
		commandArgs = [quotePosixArgv(request.command)];
	} else if (request.command.length === 1) {
		const executable = request.command[0]!;
		if (executable.includes("=")) {
			throw launchError(
				request,
				"command",
				"tmux direct execution cannot safely run a single executable name containing '='.",
			);
		}
		// tmux executes one shell-command argument with sh -c. Prefix env so
		// this remains a multi-argument direct exec; -- protects leading dashes.
		commandArgs = ["/usr/bin/env", "--", executable];
	} else {
		commandArgs = request.command;
	}
	argv.push(...commandArgs);
	const stdout = await runStep(request, operation, argv, request.cwd, runCli);
	const id = oneLineId(request, operation, stdout);
	const validId = request.placement === "pane" ? /^%\d+$/u.test(id) : /^@\d+$/u.test(id);
	if (!validId) throw launchError(request, operation, `tmux ${operation} returned an invalid ID.`);
	return { multiplexer: "tmux", placement: request.placement, id };
}

async function launchZellij(
	request: Extract<TerminalLaunchRequest, { multiplexer: "zellij" }>,
	runCli: TerminalLaunchCliRunner,
): Promise<TerminalLaunchResult> {
	if (request.placement === "window" && request.target) {
		throw launchError(request, "target", "zellij cannot target a specific tab when creating a new tab.");
	}
	if (request.placement === "pane" && request.floating && request.direction) {
		throw launchError(request, "options", "zellij floating panes do not support a split direction.");
	}
	const operation = request.placement === "pane" ? "new-pane" : "new-tab";
	const argv = ["zellij", "action", operation];
	if (request.placement === "pane") {
		if (request.floating) argv.push("--floating");
		else argv.push("--direction", request.direction ?? "right");
		if (request.target) argv.push("--tab-id", request.target);
	} else if (request.name) {
		argv.push("--name", request.name);
	}
	if (request.placement === "pane" && request.name) argv.push("--name", request.name);
	argv.push("--cwd", request.cwd);
	if (request.focus === false) argv.push("--no-focus");
	argv.push("--", ...request.command);
	const output = await runStep(request, `action ${operation}`, argv, request.cwd, runCli);
	const id = oneLineId(request, `action ${operation}`, output);
	if (request.placement === "pane") {
		if (!/^(?:terminal_)?[0-9]+$/u.test(id)) {
			throw launchError(request, `action ${operation}`, `zellij ${operation} returned an invalid ID.`);
		}
		return {
			multiplexer: "zellij",
			placement: request.placement,
			id: id.startsWith("terminal_") ? id : `terminal_${id}`,
		};
	}
	if (!/^[0-9]+$/u.test(id))
		throw launchError(request, `action ${operation}`, `zellij ${operation} returned an invalid ID.`);
	return { multiplexer: "zellij", placement: request.placement, id };
}

async function launchHerdr(
	request: Extract<TerminalLaunchRequest, { multiplexer: "herdr" }>,
	env: NodeJS.ProcessEnv,
	runCli: TerminalLaunchCliRunner,
): Promise<TerminalLaunchResult> {
	const shellCommand = quotePosixArgv(request.command);
	const focusArgs = request.focus === undefined ? [] : [request.focus ? "--focus" : "--no-focus"];
	if (request.placement === "pane") {
		const target = request.target ?? env.HERDR_PANE_ID;
		if (!target) throw launchError(request, "target", "herdr pane launch requires a pane ID.");
		const createArgv = [
			"herdr",
			"pane",
			"split",
			target,
			"--direction",
			request.direction ?? "right",
			"--cwd",
			request.cwd,
			...focusArgs,
		];
		const created = parseJson(
			request,
			"pane split",
			await runStep(request, "pane split", createArgv, request.cwd, runCli),
		);
		const paneId = nestedString(created, "result", "pane", "pane_id");
		if (!paneId) throw launchError(request, "pane split", "herdr pane split returned no pane ID.");
		await runStep(request, "pane run", ["herdr", "pane", "run", paneId, shellCommand], request.cwd, runCli);
		return { multiplexer: "herdr", placement: "pane", id: paneId };
	}

	const workspace = request.target ?? env.HERDR_WORKSPACE_ID;
	if (!workspace) throw launchError(request, "target", "herdr tab launch requires a workspace ID.");
	const createArgv = ["herdr", "tab", "create", "--workspace", workspace, "--cwd", request.cwd];
	if (request.label) createArgv.push("--label", request.label);
	createArgv.push(...focusArgs);
	const created = parseJson(
		request,
		"tab create",
		await runStep(request, "tab create", createArgv, request.cwd, runCli),
	);
	const tabId = nestedString(created, "result", "tab", "tab_id");
	const paneId = nestedString(created, "result", "root_pane", "pane_id");
	if (!tabId || !paneId) throw launchError(request, "tab create", "herdr tab create returned incomplete IDs.");
	await runStep(request, "pane run", ["herdr", "pane", "run", paneId, shellCommand], request.cwd, runCli);
	return { multiplexer: "herdr", placement: "window", id: tabId };
}

async function launchCmux(
	request: Extract<TerminalLaunchRequest, { multiplexer: "cmux" }>,
	env: NodeJS.ProcessEnv,
	runCli: TerminalLaunchCliRunner,
): Promise<TerminalLaunchResult> {
	if (request.focus !== undefined) {
		throw launchError(request, "options", "cmux launch cannot honor an explicit focus preference.");
	}
	if (request.placement === "pane") {
		// An explicit surface is authoritative. Combining it with the ambient
		// workspace can route one request across two different workspaces.
		const workspace = request.target ? undefined : env.CMUX_WORKSPACE_ID;
		const surface = request.target ?? env.CMUX_SURFACE_ID;
		if (!workspace && !surface) {
			throw launchError(request, "target", "cmux split requires a workspace or target surface ID.");
		}
		const shellCommand = `cd ${quotePosixArgument(request.cwd)} && ${quotePosixArgv(request.command)}`;
		const argv = ["cmux", "--json", "new-split", request.direction ?? "right"];
		if (workspace) argv.push("--workspace", workspace);
		if (surface) argv.push("--surface", surface);
		argv.push("--command", shellCommand);
		const output = await runStep(request, "new-split", argv, request.cwd, runCli);
		const payload = cmuxPayload(parseJson(request, "new-split", output));
		if (payload.ok === false)
			throw launchError(request, "new-split", "cmux new-split returned an unsuccessful response.");
		return { multiplexer: "cmux", placement: "pane", id: cmuxId(payload, "pane_id", "pane_ref") };
	}

	const argv = ["cmux", "--json"];
	if (request.target) argv.push("--window", request.target);
	argv.push("workspace", "create");
	if (request.name) argv.push("--name", request.name);
	argv.push("--cwd", request.cwd, "--command", quotePosixArgv(request.command));
	const output = await runStep(request, "workspace create", argv, request.cwd, runCli);
	const payload = cmuxPayload(parseJson(request, "workspace create", output));
	if (payload.ok === false)
		throw launchError(request, "workspace create", "cmux workspace create returned an unsuccessful response.");
	return {
		multiplexer: "cmux",
		placement: "window",
		id: cmuxId(payload, "workspace_id", "workspace_ref"),
	};
}
/**
 * Create a terminal pane or multiplexer group and run a command in it.
 * Provider-specific execution, targeting, environment, and focus behavior are
 * intentionally not normalized beyond the request fields; see `docs/extensions.md`.
 */
export function createTerminalLauncher(dependencies: TerminalLaunchDependencies = {}) {
	const runCli = dependencies.runCli ?? processCli;
	const environment = dependencies.environment ?? (() => process.env);
	return async (request: TerminalLaunchRequest): Promise<TerminalLaunchResult> => {
		validateRequest(request);
		const env = environment();
		requireCapability(request, env);
		switch (request.multiplexer) {
			case "tmux":
				return await launchTmux(request, env, runCli);
			case "zellij":
				return await launchZellij(request, runCli);
			case "herdr":
				return await launchHerdr(request, env, runCli);
			case "cmux":
				return await launchCmux(request, env, runCli);
		}
	};
}

export const launchTerminal = createTerminalLauncher();
