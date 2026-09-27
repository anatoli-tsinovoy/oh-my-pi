import { describe, expect, it } from "bun:test";
import {
	createTerminalLauncher,
	type TerminalLaunchCliResult,
	type TerminalLaunchCliRunner,
} from "../src/subprocess/terminal-launch";

interface CliCall {
	argv: string[];
	cwd: string;
}

function createHarness(env: NodeJS.ProcessEnv, responses: TerminalLaunchCliResult[]) {
	const calls: CliCall[] = [];
	const runCli: TerminalLaunchCliRunner = async (argv, cwd) => {
		calls.push({ argv: [...argv], cwd });
		const response = responses.shift();
		if (!response) throw new Error("unexpected CLI call");
		return response;
	};
	const launch = createTerminalLauncher({ environment: () => env, runCli });
	return { calls, launch };
}

describe("terminal launch dispatcher", () => {
	it("runs tmux pane commands with direct argv, explicit target, cwd, focus, and pane ID", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "%19\n", exitCode: 0 },
		]);

		const result = await launch({
			multiplexer: "tmux",
			placement: "pane",
			command: ["omp", "--fork", "session.jsonl"],
			cwd: "/workspace/project",
			target: "%7",
			focus: false,
			direction: "right",
			execution: "direct",
		});

		expect(calls).toEqual([
			{
				argv: [
					"tmux",
					"split-window",
					"-h",
					"-d",
					"-c",
					"/workspace/project",
					"-t",
					"%7",
					"-P",
					"-F",
					"#{pane_id}",
					"--",
					"omp",
					"--fork",
					"session.jsonl",
				],
				cwd: "/workspace/project",
			},
		]);
		expect(result).toEqual({ multiplexer: "tmux", placement: "pane", id: "%19" });
	});

	it("shell-quotes tmux argv without interpreting argument text", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "@5\n", exitCode: 0 },
		]);

		const result = await launch({
			multiplexer: "tmux",
			placement: "window",
			command: ["echo", "a'b; $(touch marker)"],
			cwd: "/tmp/work",
			target: "$0",
			execution: "shell",
		});

		expect(calls[0].argv).toEqual([
			"tmux",
			"new-window",
			"-c",
			"/tmp/work",
			"-t",
			"$0",
			"-P",
			"-F",
			"#{window_id}",
			"--",
			"'echo' 'a'\\''b; $(touch marker)'",
		]);
		expect(result).toEqual({ multiplexer: "tmux", placement: "window", id: "@5" });
	});

	it("directly launches one-element tmux commands without parsing executable text", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "%20\n", exitCode: 0 },
			{ stdout: "%21\n", exitCode: 0 },
		]);
		const executables = ["/tmp/a path/evil; $(touch marker)", "-evil; $(touch marker)"];
		for (const executable of executables) {
			await launch({
				multiplexer: "tmux",
				placement: "pane",
				command: [executable],
				cwd: "/repo",
			});
		}

		expect(calls.map(call => call.argv.slice(call.argv.indexOf("--") + 1))).toEqual(
			executables.map(executable => ["/usr/bin/env", "--", executable]),
		);
	});

	it("rejects a one-element direct executable that env would parse as an assignment", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, []);
		await expect(
			launch({
				multiplexer: "tmux",
				placement: "pane",
				command: ["command=value"],
				cwd: "/repo",
			}),
		).rejects.toThrow("cannot safely run a single executable");
		expect(calls).toEqual([]);
	});

	it("creates a tmux window in the current session without using TMUX_PANE as a window target", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "@6\n", exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "tmux",
			placement: "window",
			command: ["omp", "--resume"],
			cwd: "/repo",
		});

		expect(calls[0].argv).toEqual([
			"tmux",
			"new-window",
			"-c",
			"/repo",
			"-P",
			"-F",
			"#{window_id}",
			"--",
			"omp",
			"--resume",
		]);
		expect(result).toEqual({ multiplexer: "tmux", placement: "window", id: "@6" });
	});

	it("rejects tmux pane and window IDs as new-window session targets", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0" }, []);
		for (const target of ["%7", "@4"]) {
			await expect(
				launch({ multiplexer: "tmux", placement: "window", command: ["omp"], cwd: "/repo", target }),
			).rejects.toThrow("session ID or name");
		}
		expect(calls).toEqual([]);
	});

	it("does not infer tmux capability from TERM and requires a pane target", async () => {
		const { calls, launch } = createHarness({ TERM: "tmux-256color" }, []);
		await expect(launch({ multiplexer: "tmux", placement: "pane", command: ["omp"], cwd: "/repo" })).rejects.toThrow(
			"active TMUX session",
		);
		expect(calls).toEqual([]);

		const noPane = createHarness({ TMUX: "/tmp/tmux.sock,1,0" }, []);
		await expect(
			noPane.launch({ multiplexer: "tmux", placement: "pane", command: ["omp"], cwd: "/repo" }),
		).rejects.toThrow("target pane ID or TMUX_PANE");
		expect(noPane.calls).toEqual([]);
	});

	it("allows tmux pane and session targets when TMUX is absent", async () => {
		const pane = createHarness({}, [{ stdout: "%21\n", exitCode: 0 }]);
		const paneResult = await pane.launch({
			multiplexer: "tmux",
			placement: "pane",
			command: ["omp"],
			cwd: "/repo",
			target: "%7",
		});
		expect(pane.calls[0].argv).toContain("%7");
		expect(paneResult.id).toBe("%21");

		const window = createHarness({}, [{ stdout: "@8\n", exitCode: 0 }]);
		const windowResult = await window.launch({
			multiplexer: "tmux",
			placement: "window",
			command: ["omp"],
			cwd: "/repo",
			target: "session:review",
		});
		expect(window.calls[0].argv).toContain("session:review");
		expect(windowResult.id).toBe("@8");
	});

	it("does not treat CMUX transport or socket overrides as an active surface", async () => {
		const { calls, launch } = createHarness({ CMUX_REMOTE_TRANSPORT: "ssh", CMUX_SOCKET_PATH: "/tmp/cmux.sock" }, []);
		await expect(
			launch({
				multiplexer: "cmux",
				placement: "pane",
				command: ["npm", "run", "dev"],
				cwd: "/repo",
			}),
		).rejects.toThrow("CMUX context or explicit target ID");
		expect(calls).toEqual([]);
	});

	it("routes a CMUX split through an explicit surface without socket override inference", async () => {
		const { calls, launch } = createHarness({ CMUX_REMOTE_TRANSPORT: "ssh" }, [
			{ stdout: '{"pane_id":"pane-9"}', exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "cmux",
			placement: "pane",
			command: ["npm", "run", "dev"],
			cwd: "/repo",
			target: "surface:9",
			direction: "down",
		});

		expect(calls[0].argv).toEqual([
			"cmux",
			"--json",
			"new-split",
			"down",
			"--surface",
			"surface:9",
			"--command",
			"cd '/repo' && 'npm' 'run' 'dev'",
		]);
		expect(result).toEqual({ multiplexer: "cmux", placement: "pane", id: "pane-9" });
	});

	it("runs a Zellij pane directly and targets its tab", async () => {
		const { calls, launch } = createHarness({ ZELLIJ: "0", ZELLIJ_PANE_ID: "3" }, [{ stdout: "12\n", exitCode: 0 }]);
		const result = await launch({
			multiplexer: "zellij",
			placement: "pane",
			command: ["bun", "run", "dev"],
			cwd: "/workspace",
			target: "8",
			direction: "down",
			name: "server",
			focus: false,
			execution: "direct",
		});

		expect(calls).toEqual([
			{
				argv: [
					"zellij",
					"action",
					"new-pane",
					"--direction",
					"down",
					"--tab-id",
					"8",
					"--name",
					"server",
					"--cwd",
					"/workspace",
					"--no-focus",
					"--",
					"bun",
					"run",
					"dev",
				],
				cwd: "/workspace",
			},
		]);
		expect(result).toEqual({ multiplexer: "zellij", placement: "pane", id: "terminal_12" });
	});

	it("rejects a target that Zellij cannot apply to new-tab creation", async () => {
		const { calls, launch } = createHarness({ ZELLIJ: "0" }, []);
		await expect(
			launch({
				multiplexer: "zellij",
				placement: "window",
				command: ["bun", "run", "dev"],
				cwd: "/workspace",
				target: "8",
			}),
		).rejects.toThrow("cannot target a specific tab");
		expect(calls).toEqual([]);
	});

	it("creates a Zellij tab directly and returns its tab ID", async () => {
		const { calls, launch } = createHarness({ ZELLIJ: "0" }, [{ stdout: "7\n", exitCode: 0 }]);
		const result = await launch({
			multiplexer: "zellij",
			placement: "window",
			command: ["bun", "run", "dev"],
			cwd: "/workspace",
			name: "review",
			focus: false,
			execution: "direct",
		});

		expect(calls[0]).toEqual({
			argv: [
				"zellij",
				"action",
				"new-tab",
				"--name",
				"review",
				"--cwd",
				"/workspace",
				"--no-focus",
				"--",
				"bun",
				"run",
				"dev",
			],
			cwd: "/workspace",
		});
		expect(result).toEqual({ multiplexer: "zellij", placement: "window", id: "7" });
	});

	it("creates a Herdr pane, parses its JSON ID, then runs a safely quoted command", async () => {
		const { calls, launch } = createHarness({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, [
			{ stdout: '{"result":{"pane":{"pane_id":"w1:p2"}}}', exitCode: 0 },
			{ stdout: "", exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "herdr",
			placement: "pane",
			command: ["bun", "run", "my script.ts", "x'y"],
			cwd: "/repo with space",
			direction: "down",
			focus: false,
		});

		expect(calls).toEqual([
			{
				argv: ["herdr", "pane", "split", "w1:p1", "--direction", "down", "--cwd", "/repo with space", "--no-focus"],
				cwd: "/repo with space",
			},
			{
				argv: ["herdr", "pane", "run", "w1:p2", "'bun' 'run' 'my script.ts' 'x'\\''y'"],
				cwd: "/repo with space",
			},
		]);
		expect(result).toEqual({ multiplexer: "herdr", placement: "pane", id: "w1:p2" });
	});

	it("creates a Herdr tab in the explicit workspace and runs in its root pane", async () => {
		const { calls, launch } = createHarness({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" }, [
			{
				stdout: '{"result":{"tab":{"tab_id":"w1:t2"},"root_pane":{"pane_id":"w1:p3"}}}',
				exitCode: 0,
			},
			{ stdout: "", exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "herdr",
			placement: "window",
			command: ["omp", "--resume"],
			cwd: "/repo",
			target: "w1",
			label: "agent",
			focus: true,
		});

		expect(calls.map(call => call.argv)).toEqual([
			["herdr", "tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "agent", "--focus"],
			["herdr", "pane", "run", "w1:p3", "'omp' '--resume'"],
		]);
		expect(result).toEqual({ multiplexer: "herdr", placement: "window", id: "w1:t2" });
	});

	it("safely quotes CMUX split input and targets the explicit surface", async () => {
		const { calls, launch } = createHarness({ CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" }, [
			{ stdout: '{"pane_id":"pane-2","surface_id":"surface-2"}', exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "cmux",
			placement: "pane",
			command: ["npm", "run", "dev; echo unsafe"],
			cwd: "/repo with space",
			target: "surface:9",
			direction: "left",
			execution: "shell-input",
		});

		expect(calls).toEqual([
			{
				argv: [
					"cmux",
					"--json",
					"new-split",
					"left",
					"--surface",
					"surface:9",
					"--command",
					"cd '/repo with space' && 'npm' 'run' 'dev; echo unsafe'",
				],
				cwd: "/repo with space",
			},
		]);
		expect(result).toEqual({ multiplexer: "cmux", placement: "pane", id: "pane-2" });
	});

	it("creates a CMUX workspace in a selected window with safely quoted shell input", async () => {
		const { calls, launch } = createHarness({ CMUX_WORKSPACE_ID: "workspace:1" }, [
			{ stdout: '{"workspace_id":"workspace-2"}', exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "cmux",
			placement: "window",
			command: ["echo", "hello ' world"],
			cwd: "/repo",
			target: "window:4",
			name: "task",
			execution: "shell-input",
		});

		expect(calls[0].argv).toEqual([
			"cmux",
			"--json",
			"--window",
			"window:4",
			"workspace",
			"create",
			"--name",
			"task",
			"--cwd",
			"/repo",
			"--command",
			"'echo' 'hello '\\'' world'",
		]);
		expect(result).toEqual({ multiplexer: "cmux", placement: "window", id: "workspace-2" });
	});

	it("returns an unavailable ID when CMUX JSON omits the workspace ID", async () => {
		const { launch } = createHarness({ CMUX_WORKSPACE_ID: "workspace:1" }, [
			{ stdout: '{"name":"task"}', exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "cmux",
			placement: "window",
			command: ["omp"],
			cwd: "/repo",
		});

		expect(result.id).toBeUndefined();
	});

	it("sanitizes backend errors so command text does not escape", async () => {
		const { launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%3" }, [
			{ stdout: "TOP SECRET ARGUMENT", exitCode: 23 },
		]);
		const request = {
			multiplexer: "tmux",
			placement: "pane",
			command: ["omp", "--token", "TOP SECRET ARGUMENT"],
			cwd: "/repo",
		} as const;

		let caught: unknown;
		try {
			await launch(request);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("exit 23");
		expect((caught as Error).message).not.toContain("TOP SECRET ARGUMENT");
		expect((caught as Error).message).not.toContain("omp");
	});

	it("rejects malformed backend output instead of returning a guessed ID", async () => {
		const tmux = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%3" }, [
			{ stdout: "not-a-pane-id", exitCode: 0 },
		]);
		await expect(
			tmux.launch({ multiplexer: "tmux", placement: "pane", command: ["omp"], cwd: "/repo" }),
		).rejects.toThrow("invalid ID");

		const herdr = createHarness({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, [{ stdout: "not-json", exitCode: 0 }]);
		await expect(
			herdr.launch({ multiplexer: "herdr", placement: "pane", command: ["omp"], cwd: "/repo" }),
		).rejects.toThrow("invalid JSON");

		const zellij = createHarness({ ZELLIJ: "1" }, [{ stdout: "terminal_not-a-number", exitCode: 0 }]);
		await expect(
			zellij.launch({ multiplexer: "zellij", placement: "pane", command: ["omp"], cwd: "/repo" }),
		).rejects.toThrow("invalid ID");

		const cmux = createHarness({ CMUX_WORKSPACE_ID: "workspace:1" }, [{ stdout: "OK workspace-2\n", exitCode: 0 }]);
		await expect(
			cmux.launch({ multiplexer: "cmux", placement: "window", command: ["omp"], cwd: "/repo" }),
		).rejects.toThrow("invalid JSON");
		expect(cmux.calls).toHaveLength(1);
		expect(cmux.calls[0].argv).toContain("workspace");
		expect(cmux.calls[0].argv).toContain("create");
		expect(cmux.calls[0].argv).not.toContain("new-workspace");
	});

	it("rejects explicit CMUX focus because the creation CLI cannot honor it", async () => {
		const { calls, launch } = createHarness({ CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" }, []);
		await expect(
			launch({
				multiplexer: "cmux",
				placement: "pane",
				command: ["npm", "run", "dev"],
				cwd: "/repo",
				focus: false,
			}),
		).rejects.toThrow("cannot honor an explicit focus preference");
		expect(calls).toEqual([]);
	});
});
