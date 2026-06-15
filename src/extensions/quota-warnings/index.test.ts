import { describe, expect, it } from "vitest";
import {
  clearAlertState,
  markNotified,
  QUOTA_WARNING_COOLDOWN_MS,
  shouldNotify,
} from "./index.js";

describe("quota warning notification state", () => {
  it("suppresses repeated high and critical alerts until the cooldown expires", () => {
    clearAlertState();
    const key = "openai-codex:5h";
    const now = 1_000;

    expect(shouldNotify(key, "high", now)).toBe(true);
    markNotified(key, "high", now);

    expect(shouldNotify(key, "high", now + 30_000)).toBe(false);
    expect(shouldNotify(key, "critical", now + 30_000)).toBe(true);
    markNotified(key, "critical", now + 30_000);

    expect(shouldNotify(key, "critical", now + 60_000)).toBe(false);
    expect(shouldNotify(key, "critical", now + 30_000 + QUOTA_WARNING_COOLDOWN_MS)).toBe(true);
  });

  it("does not re-notify downgraded warnings before the cooldown", () => {
    clearAlertState();
    const key = "openai-codex:7d";
    const now = 2_000;

    markNotified(key, "high", now);

    expect(shouldNotify(key, "warning", now + 30_000)).toBe(false);
    expect(shouldNotify(key, "warning", now + QUOTA_WARNING_COOLDOWN_MS)).toBe(true);
  });
});
