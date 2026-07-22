import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createAutoresearchExtension } from "@oh-my-pi/pi-coding-agent/autoresearch";
import { closeAllAutoresearchStorages, openAutoresearchStorage } from "@oh-my-pi/pi-coding-agent/autoresearch/storage";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { TempDir } from "@oh-my-pi/pi-utils";

// Reproduces issue #3665: when the upstream system prompt resolution leaves
// `event.systemPrompt` unset, the autoresearch handler must still render its
// own block instead of crashing with `event.systemPrompt.join is not a function`.

interface CapturedHandlers {
	session_start?: ExtensionHandler<SessionStartEvent>;
	before_agent_start?: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;
}

function buildHarness(): { handlers: CapturedHandlers; activeTools: string[] } {
	const handlers: CapturedHandlers = {};
	const activeTools: string[] = [];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			(handlers as Record<string, ExtensionHandler<unknown, unknown>>)[event] = handler;
		},
		registerCommand(): void {},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools: (): string[] => [...activeTools],
		setActiveTools: async (names: string[]): Promise<void> => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		sendUserMessage(): void {},
		sendMessage(): void {},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	return { handlers, activeTools };
}

function makeCtx(
	cwd: string,
	control: { goal?: string; mode: "on" | "off"; watchSeconds?: number | null } = {
		mode: "on",
		goal: "speed up the thing",
	},
): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		hasPendingMessages: () => false,
		sessionManager: {
			getSessionId: () => "session-bas-test",
			getBranch: () => [
				{
					type: "custom",
					customType: "autoresearch-control",
					id: "ctrl-1",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					data: control,
				},
			],
		},
	} as unknown as ExtensionContext;
}
async function seedWatchedPendingRun(cwd: string, parsedPrimary: number | null) {
	const storage = await openAutoresearchStorage(cwd);
	const session = storage.openSession({
		name: "watched",
		goal: "finish the remote benchmark",
		primaryMetric: "runtime_ms",
		metricUnit: "ms",
		direction: "lower",
		preferredCommand: null,
		branch: "autoresearch/test",
		baselineCommit: null,
		maxIterations: null,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		secondaryMetrics: [],
		watchSeconds: 7.5,
	});
	const run = storage.insertRun({
		sessionId: session.id,
		segment: session.currentSegment,
		command: "bun run bench",
		logPath: `${cwd}/benchmark.log`,
		preRunDirtyPaths: [],
		startedAt: 1,
	});
	storage.markRunCompleted({
		runId: run.id,
		completedAt: 2,
		durationMs: 1_000,
		exitCode: 0,
		timedOut: false,
		parsedPrimary,
		parsedMetrics: parsedPrimary === null ? null : { runtime_ms: parsedPrimary },
		parsedAsi: null,
	});
	return { runId: run.id, storage };
}

describe("autoresearch before_agent_start handler", () => {
	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(() => {
		dbDir = TempDir.createSync("@pi-autoresearch-bas-test-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoresearch-bas-cwd-");
		vi.spyOn(git.branch, "current").mockResolvedValue("autoresearch/test");
		vi.spyOn(git.repo, "root").mockResolvedValue(cwdDir.path());
	});

	afterEach(() => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		cwdDir.removeSync();
		dbDir.removeSync();
		vi.restoreAllMocks();
	});

	it("renders an autoresearch block when event.systemPrompt is undefined (issue #3665)", async () => {
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}

		const ctx = makeCtx(cwdDir.path());
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		// Crash repro: upstream leaves event.systemPrompt unset; handler must
		// not throw, and the rendered block must still contain the autoresearch
		// header so the model gets its mode-specific instructions.
		const event = {
			type: "before_agent_start",
			prompt: "kick off",
			images: undefined,
			systemPrompt: undefined,
		} as unknown as BeforeAgentStartEvent;

		const result = (await handlers.before_agent_start(event, ctx)) as BeforeAgentStartEventResult;
		expect(result).toBeDefined();
		expect(Array.isArray(result.systemPrompt)).toBe(true);
		const blocks = result.systemPrompt as string[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("Autoresearch Mode");
	});

	it("renders the watched setup contract with its configured deadline", async () => {
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}
		const ctx = makeCtx(cwdDir.path(), { mode: "on", watchSeconds: 23 });
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		const result = (await handlers.before_agent_start(
			{ type: "before_agent_start", prompt: "build it", systemPrompt: [] } as BeforeAgentStartEvent,
			ctx,
		)) as BeforeAgentStartEventResult;
		const rendered = (result.systemPrompt as string[])[0];
		expect(rendered).toContain("### Watched harness contract (`23` seconds)");
		expect(rendered).toContain("AUTORESEARCH_PROGRESS TOKEN");
		expect(rendered).toContain("The first token and each distinct later token refresh the `23`-second deadline.");
		expect(rendered).toContain("METRIC name=value");
	});

	it("renders the watched active-run protocol from the persisted session", async () => {
		const storage = await openAutoresearchStorage(cwdDir.path());
		storage.openSession({
			name: "watched",
			goal: "finish the remote benchmark",
			primaryMetric: "runtime_ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: null,
			branch: "autoresearch/test",
			baselineCommit: null,
			maxIterations: null,
			scopePaths: [],
			offLimits: [],
			constraints: [],
			secondaryMetrics: [],
			watchSeconds: 7.5,
		});
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}
		const ctx = makeCtx(cwdDir.path());
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		const result = (await handlers.before_agent_start(
			{ type: "before_agent_start", prompt: "run it", systemPrompt: [] } as BeforeAgentStartEvent,
			ctx,
		)) as BeforeAgentStartEventResult;
		const rendered = (result.systemPrompt as string[])[0];
		expect(rendered).toContain("### Watched runs (`7.5` seconds)");
		expect(rendered).toContain("exact complete `AUTORESEARCH_PROGRESS TOKEN` stdout lines");
		expect(rendered).toContain("configured primary `METRIC`");
	});

	it("renders a watched unlogged run without its primary metric as failed", async () => {
		const { runId, storage } = await seedWatchedPendingRun(cwdDir.path(), null);
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}
		const ctx = makeCtx(cwdDir.path());
		const event = { type: "before_agent_start", prompt: "log it", systemPrompt: [] } as BeforeAgentStartEvent;
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		const missingMetricResult = (await handlers.before_agent_start(event, ctx)) as BeforeAgentStartEventResult;
		expect((missingMetricResult.systemPrompt as string[])[0]).toContain("- result: failed");

		storage.markRunCompleted({
			runId,
			completedAt: 2,
			durationMs: 1_000,
			exitCode: 0,
			timedOut: false,
			parsedPrimary: 42,
			parsedMetrics: { runtime_ms: 42 },
			parsedAsi: null,
		});
		const metricResult = (await handlers.before_agent_start(event, ctx)) as BeforeAgentStartEventResult;
		expect((metricResult.systemPrompt as string[])[0]).toContain("- result: passed");
	});

	it("omits watcher instructions when watching is disabled", async () => {
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}
		const ctx = makeCtx(cwdDir.path(), { mode: "on", watchSeconds: null });
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		const result = (await handlers.before_agent_start(
			{ type: "before_agent_start", prompt: "build it", systemPrompt: [] } as BeforeAgentStartEvent,
			ctx,
		)) as BeforeAgentStartEventResult;
		const rendered = (result.systemPrompt as string[])[0];
		expect(rendered).toContain("Autoresearch Mode");
		expect(rendered).not.toContain("Watched harness contract");
		expect(rendered).not.toContain("AUTORESEARCH_PROGRESS");
	});

	it("joins event.systemPrompt blocks into the rendered base prompt", async () => {
		const { handlers } = buildHarness();
		if (!handlers.session_start || !handlers.before_agent_start) {
			throw new Error("Autoresearch extension should register both session_start and before_agent_start");
		}

		const ctx = makeCtx(cwdDir.path());
		await handlers.session_start({ type: "session_start" } as SessionStartEvent, ctx);

		const event: BeforeAgentStartEvent = {
			type: "before_agent_start",
			prompt: "kick off",
			systemPrompt: ["alpha block", "beta block"],
		};

		const result = (await handlers.before_agent_start(event, ctx)) as BeforeAgentStartEventResult;
		expect(result).toBeDefined();
		const rendered = (result.systemPrompt as string[])[0];
		expect(rendered.startsWith("alpha block\n\nbeta block")).toBe(true);
	});
});
