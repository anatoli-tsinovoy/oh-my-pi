import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { PreparedExtension } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

function sourceHeader(id: string, cwd: string) {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		timestamp: "2026-10-01T00:00:00.000Z",
		cwd,
	};
}

function unrestrictedSourceInit() {
	return {
		type: "session_init",
		id: "inherited-init",
		parentId: null,
		timestamp: "2026-10-01T00:00:01.000Z",
		systemPrompt: ["source-only startup contract"],
		task: "source task",
		tools: ["read", "write", "task"],
		agent: "task",
		spawns: "*",
	};
}

function sourceMessage() {
	return {
		type: "message",
		id: "source-user",
		parentId: null,
		timestamp: "2026-10-01T00:00:02.000Z",
		message: { role: "user", content: "historical source request", timestamp: 1 },
	};
}

async function writeSourceSession(file: string, cwd: string): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const text = [sourceHeader("source-session", cwd), unrestrictedSourceInit(), sourceMessage()]
		.map(entry => JSON.stringify(entry))
		.join("\n");
	await Bun.write(file, `${text}\n`);
	return text + "\n";
}

function hostilePreparedExtension(onLoad: () => void): PreparedExtension {
	return {
		path: "/fixture/hostile-seance-extension.ts",
		resolvedPath: "/fixture/hostile-seance-extension.ts",
		factory: () => onLoad(),
		error: null,
	};
}

function revivalParent(cwd: string, preparedExtensions: PreparedExtension[]): AgentSession {
	return {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		effectiveExtensionRoots: {
			explicit: ["/fixture/hostile-seance-extension.ts"],
			mode: "explicit-only",
			configured: [],
			configuredLevel: "user",
		},
		preparedExtensions,
	} as unknown as AgentSession;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(() => {
	IrcBus.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("seance startup contracts", () => {
	it("builds a fresh SDK session with only historical tools and no extensions or outbound IRC", async () => {
		using tempDir = TempDir.createSync("@omp-seance-sdk-fresh-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		await writeSourceSession(sourceFile, cwd);
		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "forks"), undefined, {
			suppressBreadcrumb: true,
			neutralizeInheritedSessionInit: true,
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const extensionPath = path.join(tempDir.path(), "hostile-extension.ts");
		const extensionMarker = path.join(tempDir.path(), "extension-loaded.txt");
		const extensionSource = [
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(extensionMarker)}, "loaded");`,
			"export default api => {",
			"  api.registerTool({",
			'    name: "hostile_extension",',
			'    label: "Hostile",',
			'    description: "Should not load",',
			"    parameters: api.arktype({}),",
			'    execute: async () => ({ content: [{ type: "text", text: "loaded" }] }),',
			"  });",
			"};",
		].join("\n");
		await Bun.write(extensionPath, extensionSource);
		let session: AgentSession | undefined;
		try {
			const created = await createAgentSession({
				cwd,
				agentDir: path.join(tempDir.path(), "agent"),
				authStorage,
				modelRegistry,
				model,
				settings: Settings.isolated(),
				sessionManager: forked,
				agentName: "seance",
				toolNames: ["read", "grep", "glob"],
				requireYieldTool: true,
				restrictToolNames: true,
				enableIrc: true,
				enableMCP: true,
				enableLsp: false,
				spawns: "",
				disableExtensionDiscovery: true,
				preloadedExtensionPaths: [extensionPath],
				contextFiles: [],
				skills: [],
				rules: [],
			});
			session = created.session;

			expect(created.session.getActiveToolNames().toSorted()).toEqual(["glob", "grep", "read", "yield"]);
			expect(await Bun.file(extensionMarker).exists()).toBe(false);
		} finally {
			try {
				if (session) await session.dispose();
				else await forked.close();
			} finally {
				authStorage.close();
			}
		}
	});

	it("drops a failed pre-ready source fork without loading parent extensions or changing the source", async () => {
		using tempDir = TempDir.createSync("@omp-seance-fresh-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		const sourceText = await writeSourceSession(sourceFile, cwd);
		const artifactsDir = path.join(tempDir.path(), "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		const agent = getBundledAgent("seance");
		if (!agent) throw new Error("Expected the bundled seance agent");
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		const controller = new AbortController();
		const eventBus = new EventBus();
		const id = "SeanceStartup";
		let reachedStartedBoundary = false;
		let extensionLoaded = false;
		let extensionRootsRead = false;

		try {
			eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => {
				if (
					!payload ||
					typeof payload !== "object" ||
					!("id" in payload) ||
					payload.id !== id ||
					!("status" in payload) ||
					payload.status !== "started"
				) {
					return;
				}
				reachedStartedBoundary = true;
				controller.abort();
			});
			const extension = hostilePreparedExtension(() => {
				extensionLoaded = true;
			});
			await runSubprocess({
				cwd,
				agent,
				task: "Read the source transcript.",
				assignment: "Consult only the saved source history.",
				index: 0,
				id,
				settings: Settings.isolated(),
				modelRegistry,
				modelOverride: ["anthropic/claude-sonnet-4-5"],
				sourceSession: sourceFile,
				artifactsDir,
				preloadedPreparedExtensions: [extension],
				extensionRoots: () => {
					extensionRootsRead = true;
					return {
						explicit: [],
						mode: "merge",
						configured: [],
						configuredLevel: "user",
					};
				},
				enableIrc: true,
				signal: controller.signal,
				eventBus,
			});

			const forkFile = path.join(artifactsDir, `${id}.jsonl`);
			expect(reachedStartedBoundary).toBe(true);
			expect(await Bun.file(forkFile).exists()).toBe(false);
			expect(extensionLoaded).toBe(false);
			expect(extensionRootsRead).toBe(false);
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
		} finally {
			authStorage.close();
			setAgentDir(previousAgentDir);
		}
	});

	it("cold-revives only the restricted SDK tool set and ignores parent extensions", async () => {
		using tempDir = TempDir.createSync("@omp-seance-cold-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		await writeSourceSession(sourceFile, cwd);
		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "forks"), undefined, {
			suppressBreadcrumb: true,
			neutralizeInheritedSessionInit: true,
		});
		const sessionFile = forked.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted fork");
		forked.appendSessionInit({
			systemPrompt: ["restricted seance startup"],
			task: "read only historical task",
			tools: ["read", "grep", "glob", "yield"],
			agent: "seance",
			resolvedModel: "anthropic/claude-sonnet-4-5",
			restrictToolNames: true,
			spawns: "",
		});
		await forked.close();

		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempDir.path(), "agent"));
		let extensionLoaded = false;
		const extension = hostilePreparedExtension(() => {
			extensionLoaded = true;
		});
		const registry = AgentRegistry.global();
		const ref = registry.register({
			id: "SeanceCold",
			displayName: "seance",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile,
		});
		let revived: AgentSession | undefined;
		try {
			const createReviver = createPersistedSubagentReviverFactory({
				session: revivalParent(cwd, [extension]),
				authStorage,
				modelRegistry,
				settings: Settings.isolated(),
				enableLsp: true,
			});
			const revive = await createReviver(ref);
			if (!revive) throw new Error("Expected a cold seance reviver");
			revived = await revive(ref);

			expect(revived.getActiveToolNames().toSorted()).toEqual(["glob", "grep", "read", "yield"]);
			expect(extensionLoaded).toBe(false);
		} finally {
			try {
				await revived?.dispose();
			} finally {
				authStorage.close();
				setAgentDir(previousAgentDir);
			}
		}
	});

	it("does not offer a cold reviver when startup failed after forking but before its restricted init", async () => {
		using tempDir = TempDir.createSync("@omp-seance-failed-start-");
		const cwd = path.join(tempDir.path(), "project");
		await fs.mkdir(cwd, { recursive: true });
		const sourceFile = path.join(tempDir.path(), "source.jsonl");
		await writeSourceSession(sourceFile, cwd);
		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "forks"), undefined, {
			suppressBreadcrumb: true,
			neutralizeInheritedSessionInit: true,
		});
		const sessionFile = forked.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted fork");
		await forked.close();
		const peek = await SessionManager.peekSessionInit(sessionFile);
		expect(peek).toMatchObject({ seanceFork: true, init: null });

		const createReviver = createPersistedSubagentReviverFactory({
			session: revivalParent(cwd, []),
			authStorage: {} as AuthStorage,
			modelRegistry: {} as ModelRegistry,
			settings: Settings.isolated(),
			enableLsp: false,
		});
		const reviver = await createReviver({
			id: "FailedSeance",
			displayName: "seance",
			kind: "sub",
			parentId: "Main",
			status: "parked",
			session: null,
			sessionFile,
			createdAt: 0,
			lastActivity: 0,
		});
		expect(reviver).toBeUndefined();
	});
});
