import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sharpshooterBackend } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import { sharpshooterBankDir, sharpshooterMemoryFilePath } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";
import { appendSharpshooterDelta } from "@oh-my-pi/pi-coding-agent/sharpshooter/queue";
import type { SharpshooterDelta } from "@oh-my-pi/pi-coding-agent/sharpshooter/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(name: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

function runGit(cwd: string, args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Sharpshooter Test",
			GIT_AUTHOR_EMAIL: "sharpshooter@example.invalid",
			GIT_COMMITTER_NAME: "Sharpshooter Test",
			GIT_COMMITTER_EMAIL: "sharpshooter@example.invalid",
		},
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr || `exit ${result.exitCode}`}`);
	}
	return new TextDecoder().decode(result.stdout).trim();
}

async function createLinkedWorktree(root: string): Promise<{ primary: string; worktree: string }> {
	const primary = path.join(root, "primary");
	const worktree = path.join(root, "linked");
	await fs.mkdir(primary, { recursive: true });
	runGit(primary, ["init", "--initial-branch=main"]);
	runGit(primary, ["config", "user.email", "sharpshooter@example.invalid"]);
	runGit(primary, ["config", "user.name", "Sharpshooter Test"]);
	await Bun.write(path.join(primary, "README.md"), "fixture\n");
	runGit(primary, ["add", "-A"]);
	runGit(primary, ["commit", "-m", "fixture"]);
	runGit(primary, ["worktree", "add", worktree, "-b", "linked"]);
	return { primary, worktree };
}

function delta(statement: string, sessionId = "sharpshooter-backend"): SharpshooterDelta {
	return {
		v: 1,
		kind: "architecture_decision",
		statement,
		source: "explicit_user",
		evidence: statement,
		friction: { corrective: false, regression: false, subtle: true },
		sessionId,
		ts: Date.now(),
	};
}

describe("sharpshooter memory backend", () => {
	it("resolves from the memory.backend setting", async () => {
		const settings = Settings.isolated({ "memory.backend": "sharpshooter" });
		expect(await resolveMemoryBackend(settings)).toBe(sharpshooterBackend);
	});

	it("injects only populated project decision files", async () => {
		const root = await makeTempDir("sharpshooter-backend");
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const settings = Settings.isolated({
			"memory.backend": "sharpshooter",
			"sharpshooter.injectionTokenLimit": 2400,
		});
		await settings.reloadForCwd(cwd);

		await expect(sharpshooterBackend.buildDeveloperInstructions(agentDir, settings)).resolves.toBeUndefined();

		const bankDir = sharpshooterBankDir(agentDir, cwd);
		await fs.mkdir(bankDir, { recursive: true });
		await Promise.all([
			Bun.write(path.join(bankDir, "architecture.md"), "- Keep storage project-scoped.\n"),
			Bun.write(path.join(bankDir, "product.md"), "- Prefer explicit user controls.\n"),
			Bun.write(path.join(bankDir, "style.md"), "- Keep output concise.\n"),
		]);

		const instructions = await sharpshooterBackend.buildDeveloperInstructions(agentDir, settings);
		expect(instructions).toContain("## architecture");
		expect(instructions).toContain("## product");
		expect(instructions).toContain("## style");
	});

	it("shares injection, search, queue, stats, and clear across linked worktrees when enabled", async () => {
		const root = await makeTempDir("sharpshooter-shared-worktree");
		const { primary, worktree } = await createLinkedWorktree(root);
		const agentDir = path.join(root, "agent");
		const settings = Settings.isolated({
			"memory.backend": "sharpshooter",
			"sharpshooter.shareAcrossWorktrees": true,
		});
		await settings.reloadForCwd(worktree);
		const session = { settings } as AgentSession;
		const sharedFile = sharpshooterMemoryFilePath(agentDir, primary, "architecture.md");
		await Bun.write(sharedFile, "- Shared linked-worktree decision.\n");
		await appendSharpshooterDelta(agentDir, primary, delta("Shared queued decision."));

		const instructions = await sharpshooterBackend.buildDeveloperInstructions(agentDir, settings);
		expect(instructions).toContain("Shared linked-worktree decision.");
		const context = { agentDir, cwd: worktree, session };
		const search = await sharpshooterBackend.search?.(context, "shared linked-worktree");
		expect(search?.items.map(item => item.content)).toContain("- Shared linked-worktree decision.");
		await expect(sharpshooterBackend.queuePreview?.(context)).resolves.toContain("Shared queued decision.");
		await expect(sharpshooterBackend.stats?.(agentDir, worktree, session)).resolves.toContain("Total: 1 deltas");
		const status = await sharpshooterBackend.status?.(context);
		expect(status?.message).toContain("queue: 1");

		const isolatedCwd = path.join(root, "unrelated");
		await fs.mkdir(sharpshooterBankDir(agentDir, isolatedCwd), { recursive: true });
		const isolatedFile = sharpshooterMemoryFilePath(agentDir, isolatedCwd, "architecture.md");
		await Bun.write(isolatedFile, "- Unrelated project decision.\n");
		await sharpshooterBackend.clear(agentDir, worktree, session);
		expect(await Bun.file(sharedFile).exists()).toBe(false);
		expect(await Bun.file(isolatedFile).text()).toBe("- Unrelated project decision.\n");
	});

	it("keeps linked worktrees isolated by default", async () => {
		const root = await makeTempDir("sharpshooter-isolated-worktree");
		const { primary, worktree } = await createLinkedWorktree(root);
		const agentDir = path.join(root, "agent");
		const settings = Settings.isolated({
			"memory.backend": "sharpshooter",
			"sharpshooter.shareAcrossWorktrees": false,
		});
		await settings.reloadForCwd(worktree);
		const session = { settings } as AgentSession;
		const primaryFile = sharpshooterMemoryFilePath(agentDir, primary, "architecture.md");
		const worktreeFile = sharpshooterMemoryFilePath(agentDir, worktree, "architecture.md");
		await Bun.write(primaryFile, "- Primary-only decision.\n");
		await Bun.write(worktreeFile, "- Worktree-only decision.\n");
		await appendSharpshooterDelta(agentDir, primary, delta("Primary-only queued decision."));

		const instructions = await sharpshooterBackend.buildDeveloperInstructions(agentDir, settings);
		expect(instructions).toContain("Worktree-only decision.");
		expect(instructions).not.toContain("Primary-only decision.");
		const context = { agentDir, cwd: worktree, session };
		const search = await sharpshooterBackend.search?.(context, "primary-only");
		expect(search?.count).toBe(0);
		await expect(sharpshooterBackend.queuePreview?.(context)).resolves.toBe("Queue is empty.");
		await expect(sharpshooterBackend.stats?.(agentDir, worktree, session)).resolves.toContain("Total: 0 deltas");
		await sharpshooterBackend.clear(agentDir, worktree, session);
		expect(await Bun.file(primaryFile).text()).toBe("- Primary-only decision.\n");
		expect(await Bun.file(worktreeFile).exists()).toBe(false);
	});

	it("dispatches ACP queue and sync commands to backend hooks", async () => {
		const cwd = await makeTempDir("sharpshooter-acp-project");
		const settings = Settings.isolated({ "memory.backend": "sharpshooter" });
		const session = { settings } as AgentSession;
		const output: string[] = [];
		const queuePreview = spyOn(sharpshooterBackend, "queuePreview").mockResolvedValue("Pending delta");
		const enqueue = spyOn(sharpshooterBackend, "enqueue").mockResolvedValue(undefined);
		const runtime = {
			session,
			sessionManager: {} as SessionManager,
			settings,
			cwd,
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} satisfies SlashCommandRuntime;

		await executeAcpBuiltinSlashCommand("/memory queue", runtime);
		await executeAcpBuiltinSlashCommand("/memory sync", runtime);

		expect(queuePreview).toHaveBeenCalledWith({ agentDir: settings.getAgentDir(), cwd, session });
		expect(enqueue).toHaveBeenCalledWith(settings.getAgentDir(), cwd, session);
		expect(output).toEqual(["Pending delta", "Memory consolidation ran."]);
	});
});
