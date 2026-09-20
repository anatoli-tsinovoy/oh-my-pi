import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { OverlayHandle } from "@oh-my-pi/pi-tui";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { CopySelectorComponent, type CopySelection } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setKeybindings } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

const ENTER = "\r";
const ESC = "\x1b";
const ASSISTANT_TEXT = "The exact answer, including this comment.";

function messageEntry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00Z", message };
}

function makeEntries(): SessionMessageEntry[] {
	return [
		messageEntry("user-1", null, {
			role: "user",
			content: "Please preserve this answer exactly.",
			timestamp: 1,
		} as AgentMessage),
		messageEntry("assistant-1", "user-1", {
			role: "assistant",
			content: [{ type: "text", text: ASSISTANT_TEXT }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
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
		} as unknown as AgentMessage),
	];
}

interface SelectorHarness {
	ctx: InteractiveModeContext;
	controller: SelectorController;
	picker: () => CopySelectorComponent;
	showOverlay: Mock<(component: unknown) => OverlayHandle>;
	hide: Mock<() => void>;
}

function createHarness(entries = makeEntries()): SelectorHarness {
	let mounted: CopySelectorComponent | undefined;
	const hide = vi.fn();
	const showOverlay: Mock<(component: unknown) => OverlayHandle> = vi.fn((component: unknown): OverlayHandle => {
		mounted = component as CopySelectorComponent;
		return { hide, setHidden: vi.fn(), isHidden: () => false };
	});
	const ctx = createInteractiveModeContext({
		sessionManager: { getBranch: () => entries },
		ui: { showOverlay },
	});
	return {
		ctx,
		controller: new SelectorController(ctx),
		picker: () => {
			if (!mounted) throw new Error("selector overlay was not mounted");
			return mounted;
		},
		showOverlay,
		hide,
	};
}

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	setKeybindings(KeybindingsManager.inMemory());
});

afterEach(() => {
	setKeybindings(KeybindingsManager.inMemory());
	resetSettingsForTest();
	vi.restoreAllMocks();
});

describe("SelectorController.selectMessage", () => {
	it("returns the exact selected message and metadata without touching the clipboard", async () => {
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createHarness();
		const selectionPromise = harness.controller.selectMessage();
		const picker = harness.picker();
		picker.render(100);
		picker.handleInput(ENTER);

		const selection = await selectionPromise;
		expect(selection).toMatchObject({
			content: ASSISTANT_TEXT,
			label: "assistant message",
			kind: "message",
			entryId: "assistant-1",
			role: "assistant",
		} satisfies Partial<CopySelection>);
		expect(copy).not.toHaveBeenCalled();
		expect(harness.ctx.showStatus).not.toHaveBeenCalled();
		expect(harness.showOverlay).toHaveBeenCalledTimes(1);
		expect(harness.hide).toHaveBeenCalledTimes(1);
	});

	it("resolves undefined on cancel, disposes the mounted picker, and restores focus", async () => {
		const harness = createHarness();
		const selectionPromise = harness.controller.selectMessage();
		const picker = harness.picker();
		const dispose = vi.spyOn(picker, "dispose");
		picker.render(100);
		picker.handleInput(ESC);

		expect(await selectionPromise).toBeUndefined();
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(harness.hide).toHaveBeenCalledTimes(1);
		expect(harness.ctx.ui.setFocus).toHaveBeenLastCalledWith(harness.ctx.editor);
	});
});

describe("SelectorController.showCopySelector", () => {
	it("keeps /copy on its existing clipboard-and-status path", async () => {
		const copy = vi.spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createHarness();
		harness.controller.showCopySelector();
		const picker = harness.picker();
		picker.render(100);
		picker.handleInput(ENTER);
		await Promise.resolve();

		expect(copy).toHaveBeenCalledWith(ASSISTANT_TEXT);
		expect(harness.ctx.showStatus).toHaveBeenCalledWith("Copied assistant message to clipboard");
	});
});
