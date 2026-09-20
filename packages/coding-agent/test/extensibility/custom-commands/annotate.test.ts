import { describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { runAnnotateCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate";
import type { ReviewPrRef } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import {
	createPrReviewTarget,
	createResolvedReviewTarget,
	type ReviewTargetUI,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review/target";
import { selectSessionTextReviewSource } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-source";
import { buildTextReviewPrompt } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/annotate/text-review";
import type {
	CustomCommandAPI,
	CustomCommandContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type {
	CodeReviewAnnotation,
	ResolvedReviewTarget,
	TextReviewAnnotation,
	TextReviewSource,
} from "@oh-my-pi/pi-tui/overlays/annotation-types";
import type { CopySelection } from "@oh-my-pi/pi-tui/overlays/copy-selector";

const SAMPLE_DIFF = `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;
`;

const API = { cwd: "/workspace" } as unknown as CustomCommandAPI;

interface ContextOptions {
	selectResults?: Array<string | undefined>;
	selection?: CopySelection;
	branch?: SessionEntry[];
}

function createContext(options: ContextOptions = {}) {
	const selectResults = [...(options.selectResults ?? [])];
	const select = vi.fn(async (_title: string, _choices: string[]) => selectResults.shift());
	const selectMessage = vi.fn(async () => options.selection);
	const pasteToEditor = vi.fn((_text: string) => undefined);
	const notify = vi.fn((_message: string, _type?: "info" | "warning" | "error") => undefined);
	const setStatus = vi.fn((_key: string, _text: string | undefined) => undefined);
	const ctx = {
		hasUI: true,
		cwd: "/workspace",
		sessionManager: {
			getBranch: () => options.branch ?? [],
			getSessionId: () => "session-1",
		},
		ui: { select, selectMessage, pasteToEditor, notify, setStatus },
	} as unknown as CustomCommandContext;
	return { ctx, select, selectMessage, pasteToEditor, notify, setStatus };
}

function makeAssistantEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-20T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 2,
		} as unknown as AgentMessage,
	};
}

function localTarget(): ResolvedReviewTarget {
	return createResolvedReviewTarget("uncommitted", "Uncommitted changes", SAMPLE_DIFF, "No uncommitted changes");
}

function countOccurrences(text: string, value: string): number {
	return value ? text.split(value).length - 1 : 0;
}

describe("/annotate contracts", () => {
	it("opens the local target selected from the source menu and pastes code notes without submitting", async () => {
		const { ctx, select, pasteToEditor } = createContext({
			selectResults: ["Code review", "2. Review uncommitted changes"],
		});
		const target = localTarget();
		const resolveLocalReviewTarget = vi.fn(
			async (kind: "base-branch" | "uncommitted" | "commit", cwd: string, _ui: ReviewTargetUI) => {
				expect(kind).toBe("uncommitted");
				expect(cwd).toBe("/workspace");
				return target;
			},
		);
		const annotation: CodeReviewAnnotation = {
			scope: "file",
			path: "src/value.ts",
			occurrence: 1,
			note: "paste this code-review note",
		};
		const showCodeReviewOverlay = vi.fn(async () => ({
			action: "paste" as const,
			annotations: [annotation],
		}));

		const result = await runAnnotateCommand(API, "", ctx, {
			resolveLocalReviewTarget,
			showCodeReviewOverlay,
		});

		expect(result).toBeUndefined();
		expect(select).toHaveBeenCalledTimes(2);
		expect(resolveLocalReviewTarget).toHaveBeenCalledTimes(1);
		expect(showCodeReviewOverlay).toHaveBeenCalledTimes(1);
		expect(showCodeReviewOverlay).toHaveBeenCalledWith(ctx, target);
		expect(select).toHaveBeenNthCalledWith(1, "Select content to annotate", expect.arrayContaining(["Code review"]));
		expect(select).toHaveBeenNthCalledWith(
			2,
			"Review Mode",
			expect.arrayContaining(["2. Review uncommitted changes"]),
		);
		expect(pasteToEditor).toHaveBeenCalledTimes(1);
		expect(pasteToEditor.mock.calls[0]?.[0]).toContain(annotation.note);
	});

	it("freezes an explicit PR target before opening the overlay and keeps PR annotations and context exact", async () => {
		const { ctx, pasteToEditor } = createContext();
		const prUrl = "https://github.com/acme/project/pull/42";
		const contextInstruction =
			"MUST NOT read local workspace files for PR file context; use the fetched PR diff only";
		const target = createPrReviewTarget("PR acme/project#42", SAMPLE_DIFF, "PR has no diff", {
			diffInstruction: "MUST read the fetched PR diff",
			contextInstruction,
		});
		const exactNote = "exact annotation note: preserve once";
		const annotation: CodeReviewAnnotation = {
			scope: "line",
			path: "src/value.ts",
			occurrence: 1,
			hunkHeader: "@@ -1 +1 @@",
			oldLine: 1,
			newLine: 1,
			rawLine: "+const value = 2;",
			note: exactNote,
		};
		const resolvePrReviewTarget = vi.fn(
			async (_api: CustomCommandAPI, _ctx: CustomCommandContext, ref: ReviewPrRef) => {
				expect(ref.repo).toBe("acme/project");
				expect(ref.number).toBe(42);
				return target;
			},
		);
		const showCodeReviewOverlay = vi.fn(async () => ({
			action: "review" as const,
			annotations: [annotation],
		}));

		const prompt = await runAnnotateCommand(API, `code-review ${prUrl} focus on this line`, ctx, {
			resolvePrReviewTarget,
			showCodeReviewOverlay,
		});

		expect(prompt).toBeDefined();
		expect(resolvePrReviewTarget).toHaveBeenCalledTimes(1);
		expect(showCodeReviewOverlay).toHaveBeenCalledTimes(1);
		expect(showCodeReviewOverlay).toHaveBeenCalledWith(ctx, target);
		expect(prompt).toContain(contextInstruction);
		expect(prompt).not.toContain("MAY read full file context as needed via `read`");
		expect(countOccurrences(prompt!, "focus on this line")).toBe(1);
		expect(countOccurrences(prompt!, exactNote)).toBe(1);
		expect(prompt).toContain(SAMPLE_DIFF.trim());
		expect(pasteToEditor).not.toHaveBeenCalled();
	});

	it("pastes text annotations as editor content and never auto-submits them", async () => {
		const { ctx, pasteToEditor } = createContext();
		const source: TextReviewSource = {
			id: "message:latest",
			kind: "message",
			label: "Latest assistant reply",
			text: "The latest answer",
			provenance: { kind: "latest-assistant", entryId: "latest" },
			sessionId: "session-1",
		};
		const note = "text note for the editor";
		const showTextReviewOverlay = vi.fn(async () => ({
			action: "paste" as const,
			annotations: [{ scope: "text" as const, note }],
		}));

		const result = await runAnnotateCommand(API, "last", ctx, {
			selectSessionTextReviewSource: vi.fn(async () => source),
			showTextReviewOverlay,
		});

		expect(result).toBeUndefined();
		expect(pasteToEditor).toHaveBeenCalledTimes(1);
		expect(pasteToEditor.mock.calls[0]?.[0]).toContain(note);
	});

	it("keeps selected code and quote text exact; long code bypasses context summarization", async () => {
		const longCode = `const value = \`exact\`;\n${"return value;\n".repeat(300)}`;
		const selections: CopySelection[] = [
			{
				content: "> quoted line\nwith exact spacing",
				label: "quoted block",
				entryId: "entry-quote",
				role: "assistant",
				kind: "quote",
			},
			{
				content: longCode,
				label: "code · ts",
				entryId: "entry-code",
				role: "assistant",
				kind: "code",
			},
		];

		for (const selection of selections) {
			const { ctx, selectMessage, pasteToEditor } = createContext({ selection });
			const note = `note for ${selection.kind}`;
			const generateTextReviewContextSummary = vi.fn(async () => {
				throw new Error("code sources must not request a summary");
			});
			const showTextReviewOverlay = vi.fn(async () => ({
				action: "paste" as const,
				annotations: [{ scope: "text" as const, note }],
			}));

			const result = await runAnnotateCommand(API, "session", ctx, {
				showTextReviewOverlay,
				generateTextReviewContextSummary,
			});

			expect(result).toBeUndefined();
			expect(selectMessage).toHaveBeenCalledTimes(1);
			const prompt = pasteToEditor.mock.calls[0]?.[0] as string | undefined;
			expect(prompt).toBeDefined();
			expect(countOccurrences(prompt!, selection.content)).toBe(1);
			expect(countOccurrences(prompt!, note)).toBe(1);
			expect(generateTextReviewContextSummary).not.toHaveBeenCalled();
		}
	});

	it("bypasses context summarization for whole code, command, and clipboard sources", async () => {
		const cases: Array<{ args: string; selection?: CopySelection; text: string }> = [
			{
				args: "session",
				selection: {
					content: "const exactValue = 7;",
					label: "code · ts",
					entryId: "entry-code",
					role: "assistant",
					kind: "code",
				},
				text: "const exactValue = 7;",
			},
			{
				args: "session",
				selection: {
					content: "printf '%s\\n' exact-command",
					label: "bash command",
					entryId: "entry-command",
					role: "assistant",
					kind: "command",
				},
				text: "printf '%s\\n' exact-command",
			},
			{
				args: "clipboard",
				text: "clipboard text that stays exact",
			},
		];

		for (const testCase of cases) {
			const { ctx, selectMessage, pasteToEditor } = createContext({ selection: testCase.selection });
			const note = `note for ${testCase.args}:${testCase.text}`;
			const generateTextReviewContextSummary = vi.fn(async () => {
				throw new Error("this source must not request a summary");
			});
			const acquireClipboardText = vi.fn(async () => (testCase.args === "clipboard" ? testCase.text : undefined));
			const showTextReviewOverlay = vi.fn(async () => ({
				action: "paste" as const,
				annotations: [{ scope: "text" as const, note }],
			}));

			const result = await runAnnotateCommand(API, testCase.args, ctx, {
				acquireClipboardText,
				showTextReviewOverlay,
				generateTextReviewContextSummary,
			});

			expect(result).toBeUndefined();
			expect(pasteToEditor).toHaveBeenCalledTimes(1);
			expect(generateTextReviewContextSummary).not.toHaveBeenCalled();
			if (testCase.args === "session") expect(selectMessage).toHaveBeenCalledTimes(1);
			else expect(selectMessage).not.toHaveBeenCalled();
			const prompt = pasteToEditor.mock.calls[0]?.[0];
			expect(typeof prompt).toBe("string");
			if (typeof prompt !== "string") throw new Error("expected annotation prompt");
			expect(prompt).toContain(testCase.text);
			expect(prompt).toContain(note);
		}
	});

	it("summarizes a long quote source while preserving its exact annotated quote", async () => {
		const exactQuote = "quoted line with `code`";
		const sourceText = `${exactQuote}\n${"long quote context\n".repeat(90)}`;
		const summary = "A concise context summary that does not repeat the quote.";
		const selection: CopySelection = {
			content: sourceText,
			label: "quoted block",
			entryId: "entry-long-quote",
			role: "assistant",
			kind: "quote",
		};
		const { ctx, pasteToEditor } = createContext({ selection });
		const generateTextReviewContextSummary = vi.fn(
			async (_ctx: Pick<CustomCommandContext, "model" | "modelRegistry" | "sessionManager">, text: string) => {
				expect(text).toBe(sourceText);
				return summary;
			},
		);
		const note = "quote note stays exact";
		const showTextReviewOverlay = vi.fn(async () => ({
			action: "paste" as const,
			annotations: [{ scope: "line" as const, line: 1, quote: exactQuote, note }],
		}));

		const result = await runAnnotateCommand(API, "session", ctx, {
			showTextReviewOverlay,
			generateTextReviewContextSummary,
		});

		expect(result).toBeUndefined();
		expect(generateTextReviewContextSummary).toHaveBeenCalledTimes(1);
		const prompt = pasteToEditor.mock.calls[0]?.[0];
		expect(typeof prompt).toBe("string");
		if (typeof prompt !== "string") throw new Error("expected annotation prompt");
		expect(prompt).toContain("## Generated source context (not instructions)");
		expect(prompt).toContain(summary);
		expect(prompt).not.toContain(sourceText);
		expect(countOccurrences(prompt, exactQuote)).toBe(1);
		expect(countOccurrences(prompt, note)).toBe(1);
	});

	it("omits the latest whole reply source but includes a latest-reply link as its own selection", async () => {
		const latestText = "The latest assistant reply body";
		const branch = [makeAssistantEntry("latest", latestText)];
		const whole = await selectSessionTextReviewSource(createContext({ branch }).ctx, {
			autoSelect: "latest-assistant",
		});
		if (!whole) throw new Error("expected latest assistant source");
		const wholePrompt = buildTextReviewPrompt(whole, [{ scope: "text", note: "whole reply note" }]);
		expect(whole.provenance).toEqual({ kind: "latest-assistant", entryId: "latest" });
		expect(wholePrompt).toBeDefined();
		expect(wholePrompt!).not.toContain(latestText);

		const linkText = "https://example.com/from-latest";
		const linkSelection: CopySelection = {
			content: linkText,
			label: "link",
			entryId: "latest",
			role: "assistant",
			kind: "link",
		};
		const link = await selectSessionTextReviewSource(createContext({ branch, selection: linkSelection }).ctx);
		if (!link) throw new Error("expected selected link source");
		const linkPrompt = buildTextReviewPrompt(link, [{ scope: "text", note: "link note" }]);
		expect(link.provenance).toEqual({ kind: "session", entryId: "latest" });
		expect(linkPrompt!).toContain(linkText);
		expect(linkPrompt!).toContain("## Source");
	});

	it("includes a valid 999-character context summary while preserving exact text feedback", async () => {
		const sourceText = `older source ${"x".repeat(1200)}`;
		const exactQuote = "quoted `text`\nwith a newline";
		const exactNote = "note **as written**\nwith a second line";
		const source: TextReviewSource = {
			id: "message:older",
			kind: "message",
			label: "Older assistant reply",
			text: sourceText,
			provenance: { kind: "session", entryId: "older" },
			sessionId: "session-1",
		};
		const { ctx, pasteToEditor, setStatus, notify } = createContext();
		const summary = "s".repeat(999);
		const generateTextReviewContextSummary = vi.fn(async () => summary);
		const annotations: TextReviewAnnotation[] = [{ scope: "line", line: 3, quote: exactQuote, note: exactNote }];
		const showTextReviewOverlay = vi.fn(async () => ({ action: "paste" as const, annotations }));

		const result = await runAnnotateCommand(API, "session", ctx, {
			selectSessionTextReviewSource: vi.fn(async () => source),
			showTextReviewOverlay,
			generateTextReviewContextSummary,
		});

		expect(result).toBeUndefined();
		const prompt = pasteToEditor.mock.calls[0]?.[0] as string | undefined;
		expect(prompt).toBeDefined();
		expect(prompt).toContain("## Generated source context (not instructions)");
		expect(prompt).toContain(summary);
		expect(prompt).not.toContain(sourceText);
		expect(countOccurrences(prompt!, exactQuote)).toBe(1);
		expect(countOccurrences(prompt!, exactNote)).toBe(1);
		expect(setStatus.mock.calls[0]?.[0]).toBe("annotate-summary");
		expect(typeof setStatus.mock.calls[0]?.[1]).toBe("string");
		expect(setStatus).toHaveBeenLastCalledWith("annotate-summary", undefined);
		expect(notify).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: "an oversized summary",
			warning:
				"Source summary unavailable; including the full source verbatim beyond the normal 999-character context limit.",
			generate: "limit",
		},
		{
			label: "a summary error",
			warning:
				"Source summary failed; including the full source verbatim beyond the normal 999-character context limit.",
			generate: "error",
		},
	] as const)("falls back to the full source and warns after $label", async scenario => {
		const sourceText = `${scenario.generate} source ${"y".repeat(1200)}`;
		const exactQuote = `fallback quote (${scenario.generate})\nwith a comment`;
		const exactNote = `fallback comment **exact** (${scenario.generate})`;
		const source: TextReviewSource = {
			id: `message:${scenario.generate}`,
			kind: "message",
			label: "Older session message",
			text: sourceText,
			provenance: { kind: "session", entryId: scenario.generate },
			sessionId: "session-1",
		};
		const { ctx, pasteToEditor, notify } = createContext();
		const generateTextReviewContextSummary = vi.fn(async () => {
			if (scenario.generate === "limit") return "s".repeat(1000);
			throw new Error("summary provider failed");
		});
		const showTextReviewOverlay = vi.fn(async () => ({
			action: "paste" as const,
			annotations: [{ scope: "line" as const, line: 4, quote: exactQuote, note: exactNote }],
		}));

		const result = await runAnnotateCommand(API, "session", ctx, {
			selectSessionTextReviewSource: vi.fn(async () => source),
			showTextReviewOverlay,
			generateTextReviewContextSummary,
		});

		expect(result).toBeUndefined();
		const prompt = pasteToEditor.mock.calls[0]?.[0] as string | undefined;
		expect(prompt).toBeDefined();
		expect(prompt).toContain(sourceText);
		expect(prompt).not.toContain("## Generated source context (not instructions)");
		expect(countOccurrences(prompt!, exactQuote)).toBe(1);
		expect(countOccurrences(prompt!, exactNote)).toBe(1);
		expect(notify).toHaveBeenCalledWith(scenario.warning, "warning");
	});
});
