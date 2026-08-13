import { describe, expect, it } from "bun:test";
import { getDefaultSttModelKey, getSttModelOptions, resolveSttModelSpec } from "@oh-my-pi/pi-coding-agent/stt/models";

describe("speech-to-text model availability", () => {
	it("uses Whisper on Android where the sherpa native addon is unavailable", () => {
		expect(getDefaultSttModelKey("android")).toBe("whisper-base");
		expect(resolveSttModelSpec(undefined, "android").key).toBe("whisper-base");
		expect(resolveSttModelSpec("parakeet-tdt-0.6b-v3", "android").key).toBe("whisper-base");
		expect(getSttModelOptions("android").map(option => option.value)).toEqual([
			"whisper-base",
			"whisper-small",
			"whisper-large-v3-turbo",
		]);
	});

	it("keeps Parakeet as the default where sherpa has a native addon", () => {
		expect(getDefaultSttModelKey("linux")).toBe("parakeet-tdt-0.6b-v3");
		expect(resolveSttModelSpec(undefined, "linux").key).toBe("parakeet-tdt-0.6b-v3");
		expect(resolveSttModelSpec("parakeet-tdt-0.6b-v3", "linux").key).toBe("parakeet-tdt-0.6b-v3");
		expect(getSttModelOptions("linux").map(option => option.value)).toContain("parakeet-tdt-0.6b-v3");
	});
});
