import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	buildSharpshooterEnvelope,
	maybeStartSharpshooterExtraction,
} from "@oh-my-pi/pi-coding-agent/sharpshooter/extract";
import { listSharpshooterDeltas } from "@oh-my-pi/pi-coding-agent/sharpshooter/queue";

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

function message(role: "user" | "assistant", content: unknown): AgentMessage {
	return { role, content, timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantResponse(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function extractionDependencies(
	cwd: string,
	messages: AgentMessage[],
	sessionId = "session-extract",
	shareAcrossWorktrees = false,
) {
	const model = getBundledModel("anthropic", "claude-haiku-4-5");
	if (!model) throw new Error("Expected bundled Claude Haiku model");
	const scope = { value: shareAcrossWorktrees };
	const settings = {
		get(key: string) {
			if (key === "sharpshooter.model") return `${model.provider}/${model.id}`;
			if (key === "sharpshooter.shareAcrossWorktrees") return scope.value;
			return undefined;
		},
		getModelRole() {
			return undefined;
		},
		getStorage() {
			return undefined;
		},
	} as unknown as Settings;
	const modelRegistry = {
		getAll: () => [model],
		getAvailable: () => [model],
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
	const session = {
		isDisposed: false,
		messages,
		sessionId,
		sessionManager: { getCwd: () => cwd },
	} as unknown as AgentSession;
	return { modelRegistry, session, settings, scope };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await predicate()) return;
	}
	if (!(await predicate())) throw new Error(message);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("buildSharpshooterEnvelope", () => {
	it("selects visible referent context, strips fenced code, and enforces caps", () => {
		const previousHuman = `nearest user \`\`\`ts\nconst secret = true;\n\`\`\` ${"p".repeat(500)}`;
		const assistantText = `nearest assistant \`\`\`sh\necho secret\n\`\`\` ${"a".repeat(900)}`;
		const messages = [
			message("user", [{ type: "text", text: "older user" }]),
			message("assistant", [{ type: "text", text: "older assistant" }]),
			message("user", [{ type: "text", text: previousHuman }]),
			message("assistant", [
				{ type: "thinking", thinking: "private chain of thought" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "hidden" } },
				{ type: "text", text: assistantText },
			]),
			message("user", [{ type: "text", text: "Keep the cyan status indicator exactly as designed." }]),
		];

		const envelope = buildSharpshooterEnvelope(messages);

		expect(envelope?.prompt).toBe("Keep the cyan status indicator exactly as designed.");
		expect(envelope?.previousHuman).toHaveLength(400);
		expect(envelope?.previousHuman).toStartWith("nearest user [code omitted]");
		expect(envelope?.previousHuman).not.toContain("const secret");
		expect(envelope?.assistantContext).toHaveLength(800);
		expect(envelope?.assistantContext).toStartWith("nearest assistant [code omitted]");
		expect(envelope?.assistantContext).not.toContain("private chain of thought");
		expect(envelope?.assistantContext).not.toContain("hidden");
	});

	it("returns no referent fields when none are available and undefined without a user prompt", () => {
		expect(
			buildSharpshooterEnvelope([
				message("user", [{ type: "text", text: "This prompt has no prior conversation." }]),
			]),
		).toEqual({ prompt: "This prompt has no prior conversation." });
		expect(
			buildSharpshooterEnvelope([message("assistant", [{ type: "text", text: "No user yet" }])]),
		).toBeUndefined();
	});
});

describe("maybeStartSharpshooterExtraction", () => {
	it("allows only one in-flight extraction for a session", async () => {
		const cwd = path.join(os.tmpdir(), "sharpshooter-in-flight-project");
		const deps = extractionDependencies(cwd, [
			message("user", [{ type: "text", text: "Keep this product behavior stable across every release." }]),
		]);
		const pending = Promise.withResolvers<AssistantMessage>();
		const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => pending.promise);

		maybeStartSharpshooterExtraction({
			agentDir: path.join(os.tmpdir(), "sharpshooter-in-flight-agent"),
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});
		await waitFor(() => completion.mock.calls.length === 1, "first completion was not called");
		maybeStartSharpshooterExtraction({
			agentDir: path.join(os.tmpdir(), "sharpshooter-in-flight-agent"),
			modelRegistry: deps.modelRegistry,
			session: deps.session,
			settings: deps.settings,
		});

		expect(completion).toHaveBeenCalledTimes(1);
		pending.resolve(assistantResponse([{ type: "text", text: "No tool call." }]));
		await pending.promise;
		await Promise.resolve();
		await Promise.resolve();
	});

	it("keeps in-flight extraction in its captured shared worktree bank", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "sharpshooter-extract-worktree-"));
		try {
			const { primary, worktree } = await createLinkedWorktree(root);
			const agentDir = path.join(root, "agent");
			const currentPrompt = "Keep the shared status indicator stable across every release.";
			const deps = extractionDependencies(
				worktree,
				[message("user", [{ type: "text", text: currentPrompt }])],
				"session-shared",
				true,
			);
			const pending = Promise.withResolvers<AssistantMessage>();
			const completion = vi.spyOn(ai, "completeSimple").mockImplementation(() => pending.promise);

			maybeStartSharpshooterExtraction({
				agentDir,
				modelRegistry: deps.modelRegistry,
				session: deps.session,
				settings: deps.settings,
			});
			await waitFor(() => completion.mock.calls.length === 1, "shared extraction did not start");
			deps.scope.value = false;
			pending.resolve(
				assistantResponse([
					{
						type: "toolCall",
						id: "call-record",
						name: "record_deltas",
						arguments: {
							deltas: [
								{
									kind: "style_decision",
									statement: "Shared status indicator remains stable.",
									source: "explicit_user",
									evidence: "shared status indicator",
									friction: { corrective: true, regression: false, subtle: true },
								},
							],
						},
					},
				]),
			);

			await waitFor(
				async () => (await listSharpshooterDeltas(agentDir, primary)).length === 1,
				"captured shared delta was not queued",
			);
			expect(await listSharpshooterDeltas(agentDir, worktree)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("queues only deltas whose evidence is a verbatim prompt substring", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "sharpshooter-extract-"));
		try {
			const cwd = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			const currentPrompt = "Keep the cyan status indicator and never replace it with magenta.";
			const deps = extractionDependencies(cwd, [message("user", [{ type: "text", text: currentPrompt }])]);
			vi.spyOn(ai, "completeSimple").mockResolvedValue(
				assistantResponse([
					{
						type: "toolCall",
						id: "call-record",
						name: "record_deltas",
						arguments: {
							deltas: [
								{
									kind: "style_decision",
									statement: "Status indicator uses cyan rather than magenta.",
									rejectedAlternative: "Magenta status indicator",
									rationale: "The cyan treatment is intentional.",
									source: "explicit_user",
									evidence: "cyan status indicator",
									friction: { corrective: true, regression: false, subtle: true },
								},
								{
									kind: "product_decision",
									statement: "The status indicator is always green.",
									source: "explicit_user",
									evidence: "always green",
									friction: { corrective: false, regression: false, subtle: false },
								},
							],
						},
					},
				]),
			);

			maybeStartSharpshooterExtraction({
				agentDir,
				modelRegistry: deps.modelRegistry,
				session: deps.session,
				settings: deps.settings,
			});
			await waitFor(async () => (await listSharpshooterDeltas(agentDir, cwd)).length === 1, "delta was not queued");

			const groups = await listSharpshooterDeltas(agentDir, cwd);
			expect(groups).toHaveLength(1);
			expect(groups[0]?.deltas).toHaveLength(1);
			expect(groups[0]?.deltas[0]?.delta).toEqual({
				v: 1,
				kind: "style_decision",
				statement: "Status indicator uses cyan rather than magenta.",
				rejectedAlternative: "Magenta status indicator",
				rationale: "The cyan treatment is intentional.",
				source: "explicit_user",
				evidence: "cyan status indicator",
				friction: { corrective: true, regression: false, subtle: true },
				sessionId: "session-extract",
				ts: expect.any(Number),
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("ignores a non-tool text response without writing queue files", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "sharpshooter-extract-text-"));
		try {
			const cwd = path.join(root, "project");
			const agentDir = path.join(root, "agent");
			const deps = extractionDependencies(cwd, [
				message("user", [{ type: "text", text: "Preserve this product behavior exactly as it is." }]),
			]);
			const completion = vi
				.spyOn(ai, "completeSimple")
				.mockResolvedValue(assistantResponse([{ type: "text", text: "No tool call." }]));

			expect(() =>
				maybeStartSharpshooterExtraction({
					agentDir,
					modelRegistry: deps.modelRegistry,
					session: deps.session,
					settings: deps.settings,
				}),
			).not.toThrow();
			await waitFor(() => completion.mock.calls.length === 1, "completion was not called");
			await Promise.resolve();
			await Promise.resolve();

			expect(await listSharpshooterDeltas(agentDir, cwd)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
