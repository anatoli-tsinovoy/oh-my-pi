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
): ForkTerminalLaunchPlan {
	if (!multiplexer) {
		return {
			error: `Cannot open a fork ${placement}: no supported terminal multiplexer was detected. Supported: ${SUPPORTED_MULTIPLEXERS}. Run /fork without a placement to fork in this process.`,
		};
	}

	if (multiplexer === "screen" || multiplexer === "wmux") {
		return {
			error: `Cannot open a fork ${placement} in ${multiplexer}: this multiplexer is not supported. Supported: ${SUPPORTED_MULTIPLEXERS}.`,
		};
	}

	const request = { multiplexer, placement, command, cwd } as TerminalLaunchRequest;
	return { request };
}
