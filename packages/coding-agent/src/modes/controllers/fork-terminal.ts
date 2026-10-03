import type { TerminalMultiplexer } from "@oh-my-pi/pi-tui/terminal-multiplexer";
import type { TerminalLaunchPlacement, TerminalLaunchRequest } from "../../subprocess/terminal-launch";

export type ForkTerminalLaunchPlan = { request: TerminalLaunchRequest } | { error: string };

const SUPPORTED_MULTIPLEXERS = "tmux, Zellij, Herdr, and CMUX";

/** Resolve a fork placement into a supported terminal-launch request. */
export function createForkTerminalLaunchPlan(
	multiplexer: TerminalMultiplexer | null,
	placement: TerminalLaunchPlacement,
	command: readonly string[],
	cwd: string,
	shellGrammar?: "posix",
): ForkTerminalLaunchPlan {
	if (!multiplexer) {
		return {
			error: `Cannot open a fork ${placement}: no supported terminal multiplexer was detected. Supported: ${SUPPORTED_MULTIPLEXERS}. Run /fork without a placement to fork in this process.`,
		};
	}

	switch (multiplexer) {
		case "screen":
		case "wmux":
			return {
				error: `Cannot open a fork ${placement} in ${multiplexer}: this multiplexer is not supported. Supported: ${SUPPORTED_MULTIPLEXERS}.`,
			};
		case "tmux":
			if (placement === "pane") {
				return { request: { multiplexer: "tmux", placement: "pane", command, cwd } };
			}
			return { request: { multiplexer: "tmux", placement: "window", command, cwd } };
		case "zellij":
			if (placement === "pane") {
				return { request: { multiplexer: "zellij", placement: "pane", command, cwd } };
			}
			return { request: { multiplexer: "zellij", placement: "window", command, cwd } };
		case "herdr":
			if (shellGrammar !== "posix") {
				return {
					error: `Cannot open a fork ${placement} in Herdr until POSIX shell compatibility is confirmed for the destination.`,
				};
			}
			if (placement === "pane") {
				return {
					request: { multiplexer: "herdr", placement: "pane", command, cwd, shellGrammar: "posix" },
				};
			}
			return { request: { multiplexer: "herdr", placement: "window", command, cwd, shellGrammar: "posix" } };
		case "cmux":
			if (shellGrammar !== "posix") {
				return {
					error: `Cannot open a fork ${placement} in CMUX until POSIX shell compatibility is confirmed for the destination.`,
				};
			}
			if (placement === "pane") {
				return {
					request: { multiplexer: "cmux", placement: "pane", command, cwd, shellGrammar: "posix" },
				};
			}
			return { request: { multiplexer: "cmux", placement: "window", command, cwd, shellGrammar: "posix" } };
	}
}
