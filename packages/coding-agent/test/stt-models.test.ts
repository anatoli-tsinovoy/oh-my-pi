import { describe, expect, it } from "bun:test";
import {
	getDefaultSttModelKey,
	getSttModelOptions,
	resolveSttModelSpec,
} from "@oh-my-pi/pi-coding-agent/stt/models";

describe("speech-to-text model availability", () => {
	it("uses Whisper on Android where the sherpa native addon is unavailable", () => {
		expect(getDefaultSttModelKey("android")).toBe("fast");
		expect(resolveSttModelSpec(undefined, "android").key).toBe("fast");
		expect(resolveSttModelSpec("parakeet", "android").key).toBe("fast");
		expect(getSttModelOptions("android").map(option => option.value)).toEqual(["fast", "balanced", "turbo"]);
	});

	it("keeps Parakeet as the default where sherpa has a native addon", () => {
		expect(getDefaultSttModelKey("linux")).toBe("parakeet");
		expect(resolveSttModelSpec(undefined, "linux").key).toBe("parakeet");
		expect(resolveSttModelSpec("parakeet", "linux").key).toBe("parakeet");
		expect(getSttModelOptions("linux").map(option => option.value)).toContain("parakeet");
	});
});
