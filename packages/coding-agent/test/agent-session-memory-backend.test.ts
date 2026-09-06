import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiScopedDbPaths, getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Mnemopi, resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function runGit(cwd: string, args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Memory Backend Test",
			GIT_AUTHOR_EMAIL: "memory-backend@example.invalid",
			GIT_COMMITTER_NAME: "Memory Backend Test",
			GIT_COMMITTER_EMAIL: "memory-backend@example.invalid",
		},
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		const stdout = new TextDecoder().decode(result.stdout).trim();
		throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout || `exit ${result.exitCode}`}`);
	}
}

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} memory tool`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

describe("AgentSession memory backend lifecycle", () => {
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let settings: Settings;
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@memory-backend-lifecycle-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("openai", "test-key");
		settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "off",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
		});
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		resetMemoryForTests();
		authStorage.close();
		tempDir.removeSync();
	});

	function createSession(createMemoryTools: () => Promise<AgentTool[]>, cwd = tempDir.path()): AgentSession {
		const model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		const read = createTool("read");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["initial"], tools: [read] },
			streamFn: createMockModel({ responses: [{ content: ["ok"] }], handler: { content: ["ok"] } }).stream,
		});
		const toolRegistry = new Map<string, AgentTool>([[read.name, read]]);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			memoryAgentDir: tempDir.path(),
			memoryTaskDepth: 0,
			createMemoryTools,
			toolRegistry,
			builtInToolNames: [read.name],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`backend:${settings.get("memory.backend")};tools:${toolNames.sort().join(",")}`],
			}),
		});
		return session;
	}

	it("switches runtime state, memory tools, and prompt in one apply", async () => {
		const current = createSession(async () =>
			settings.get("memory.backend") === "mnemopi" ? [createTool("retain"), createTool("memory_edit")] : [],
		);

		settings.override("memory.backend", "mnemopi");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeDefined();
		expect(current.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "retain", "memory_edit"]));
		expect(current.systemPrompt).toEqual(["backend:mnemopi;tools:memory_edit,read,retain"]);

		settings.override("memory.backend", "off");
		await current.applyMemoryBackend();

		expect(getMnemopiSessionState(current)).toBeUndefined();
		expect(current.getActiveToolNames()).toEqual(["read"]);
		expect(current.getAllToolNames()).toEqual(["read"]);
		expect(current.systemPrompt).toEqual(["backend:off;tools:read"]);
	});
	it("reapplies live Mnemopi worktree scope and restores isolation", async () => {
		const fixtureRoot = path.join(tempDir.path(), "git-fixture");
		const primaryRoot = path.join(fixtureRoot, "repo");
		const worktreeRoot = path.join(fixtureRoot, "repo-feature");
		await fs.mkdir(primaryRoot, { recursive: true });
		runGit(primaryRoot, ["-c", "init.defaultBranch=main", "init"]);
		await Bun.write(path.join(primaryRoot, "README.txt"), "primary\n");
		runGit(primaryRoot, ["add", "-A"]);
		runGit(primaryRoot, ["commit", "-m", "base"]);
		runGit(primaryRoot, ["worktree", "add", worktreeRoot, "-b", "feature"]);

		settings.override("memory.backend", "mnemopi");
		settings.override("mnemopi.scoping", "per-project");
		settings.override("mnemopi.autoRecall", false);
		settings.override("mnemopi.autoRetain", false);
		await settings.reloadForCwd(worktreeRoot);
		const current = createSession(async () => [], worktreeRoot);
		await current.applyMemoryBackend();

		const initialState = getMnemopiSessionState(current);
		expect(initialState).toBeDefined();
		const isolatedBank = initialState!.config.bank;
		const primarySettings = await settings.cloneForCwd(primaryRoot);
		const primaryConfig = loadMnemopiConfig(primarySettings, tempDir.path());
		expect(isolatedBank).not.toBe(primaryConfig.bank);

		const primaryDbPath = getMnemopiScopedDbPaths(primaryConfig)[0];
		if (!primaryDbPath) throw new Error("Mnemopi primary bank path was not resolved");
		const marker = "shared worktree memory marker";
		const seed = new Mnemopi({
			dbPath: primaryDbPath,
			bank: primaryConfig.bank,
			sessionId: "primary-seed",
			authorId: "memory-backend-test",
			authorType: "agent",
			channelId: primaryConfig.bank,
			noEmbeddings: true,
			llm: false,
		});
		try {
			seed.remember(marker, { source: "test", scope: "bank", extract: false });
			await seed.flushExtractions();
		} finally {
			seed.close();
		}

		const searchContext = { agentDir: tempDir.path(), cwd: worktreeRoot, session: current };
		const isolatedSearch = await mnemopiBackend.search!(searchContext, marker);
		expect(isolatedSearch).toMatchObject({ backend: "mnemopi", count: 0 });

		const sessionId = current.sessionId;
		settings.override("mnemopi.shareAcrossWorktrees", true);
		await current.prompt("settle the shared memory scope");

		const sharedState = getMnemopiSessionState(current);
		expect(current.sessionId).toBe(sessionId);
		expect(sharedState?.config.bank).toBe(primaryConfig.bank);
		const sharedSearch = await mnemopiBackend.search!(searchContext, marker);
		expect(sharedSearch).toMatchObject({
			backend: "mnemopi",
			items: expect.arrayContaining([expect.objectContaining({ content: marker })]),
		});

		settings.override("mnemopi.shareAcrossWorktrees", false);
		await current.prompt("settle the isolated memory scope");

		const restoredState = getMnemopiSessionState(current);
		expect(restoredState?.config.bank).toBe(isolatedBank);
		const restoredSearch = await mnemopiBackend.search!(searchContext, marker);
		expect(restoredSearch).toMatchObject({ backend: "mnemopi", count: 0 });
	});

	it("cancels a displaced local startup generation", async () => {
		const current = createSession(async () => []);
		const localStartup = current.beginLocalMemoryStartup();

		await current.applyMemoryBackend();

		expect(localStartup.aborted).toBe(true);
	});

	it("serializes concurrent backend applies", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let calls = 0;
		let running = 0;
		let maxRunning = 0;
		const current = createSession(async () => {
			calls++;
			running++;
			maxRunning = Math.max(maxRunning, running);
			if (calls === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			running--;
			return [];
		});

		const first = current.applyMemoryBackend();
		await firstStarted.promise;
		const second = current.applyMemoryBackend();
		await Promise.resolve();
		expect(calls).toBe(1);
		releaseFirst.resolve();
		await Promise.all([first, second]);

		expect(maxRunning).toBe(1);
		expect(calls).toBe(2);
	});
});
