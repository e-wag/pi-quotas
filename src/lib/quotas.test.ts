import { describe, it, expect } from "vitest";
import {
  resolveQuotaProvider,
  resolveQuotaProviderHost,
  filterWindowsForHost,
  isSupportedProvider,
} from "./quotas.js";
import type { ProviderPrefixMap } from "../config.js";
import type { QuotaWindow } from "../types/quotas.js";

const prefixes: ProviderPrefixMap = {
  "acme-copilot/": "github-copilot",
  "acme-codex/": "openai-codex",
  "acme-openrouter/": "openrouter",
};

describe("resolveQuotaProvider", () => {
  it("returns the provider directly when it is supported", () => {
    expect(resolveQuotaProvider("anthropic", "claude-opus-4", {})).toBe("anthropic");
    expect(resolveQuotaProvider("github-copilot", "claude", prefixes)).toBe("github-copilot");
  });

  it("routes by longest matching prefix", () => {
    expect(resolveQuotaProvider("acme-proxy", "acme-copilot/claude-sonnet", prefixes)).toBe(
      "github-copilot",
    );
    expect(resolveQuotaProvider("acme-proxy", "acme-codex/gpt-5", prefixes)).toBe("openai-codex");
    expect(resolveQuotaProvider("acme-proxy", "acme-openrouter/deepseek", prefixes)).toBe("openrouter");
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveQuotaProvider("acme-proxy", "unknown/model", prefixes)).toBeUndefined();
    expect(resolveQuotaProvider("acme-proxy", undefined, prefixes)).toBeUndefined();
    expect(resolveQuotaProvider(undefined, undefined, prefixes)).toBeUndefined();
  });

  it("handles empty prefix map", () => {
    expect(resolveQuotaProvider("acme-proxy", "acme-copilot/x", {})).toBeUndefined();
  });

  it("resolves to a value that isSupportedProvider accepts", () => {
    const resolved = resolveQuotaProvider("acme-proxy", "acme-copilot/claude", prefixes);
    expect(isSupportedProvider(resolved)).toBe(true);
  });

  it("picks the longest matching prefix", () => {
    const mixed: ProviderPrefixMap = {
      "a/": "openai-codex",
      "a/b/": "github-copilot",
    };
    expect(resolveQuotaProvider("proxy", "a/b/model", mixed)).toBe("github-copilot");
    expect(resolveQuotaProvider("proxy", "a/c/model", mixed)).toBe("openai-codex");
  });

  it("accepts object-form prefix targets carrying a host override", () => {
    const multi: ProviderPrefixMap = {
      "copilot-enterprise/": { provider: "github-copilot", host: "enterprise.ghe.com" },
      "copilot-personal/": { provider: "github-copilot", host: "github.com" },
    };
    expect(resolveQuotaProvider("headroom", "copilot-enterprise/claude-haiku", multi)).toBe(
      "github-copilot",
    );
    expect(resolveQuotaProvider("headroom", "copilot-personal/claude-haiku", multi)).toBe(
      "github-copilot",
    );
  });
});

describe("resolveQuotaProviderHost", () => {
  it("returns the host override for object-form prefix targets", () => {
    const multi: ProviderPrefixMap = {
      "copilot-enterprise/": { provider: "github-copilot", host: "enterprise.ghe.com" },
      "copilot-personal/": { provider: "github-copilot", host: "github.com" },
    };
    expect(resolveQuotaProviderHost("copilot-enterprise/claude-haiku", multi)).toBe("enterprise.ghe.com");
    expect(resolveQuotaProviderHost("copilot-personal/claude-haiku", multi)).toBe("github.com");
  });

  it("returns undefined for bare-string prefix targets", () => {
    const bare: ProviderPrefixMap = {
      "acme-copilot/": "github-copilot",
    };
    expect(resolveQuotaProviderHost("acme-copilot/claude", bare)).toBeUndefined();
  });

  it("returns undefined when no prefix matches", () => {
    const multi: ProviderPrefixMap = {
      "copilot-personal/": { provider: "github-copilot", host: "github.com" },
    };
    expect(resolveQuotaProviderHost("unknown/model", multi)).toBeUndefined();
    expect(resolveQuotaProviderHost(undefined, multi)).toBeUndefined();
    expect(resolveQuotaProviderHost("copilot-personal/x", undefined)).toBeUndefined();
  });

  it("picks the longest matching prefix", () => {
    const mixed: ProviderPrefixMap = {
      "a/": { provider: "github-copilot", host: "github.com" },
      "a/b/": { provider: "github-copilot", host: "enterprise.ghe.com" },
    };
    expect(resolveQuotaProviderHost("a/b/model", mixed)).toBe("enterprise.ghe.com");
    expect(resolveQuotaProviderHost("a/c/model", mixed)).toBe("github.com");
  });
});

describe("filterWindowsForHost", () => {
  const copilotWindows: QuotaWindow[] = [
    { provider: "github-copilot", host: "enterprise.ghe.com", label: "Copilot enterprise.ghe.com", usedPercent: 88, resetsAt: new Date(), windowSeconds: 0, usedValue: 0, limitValue: 0 },
    { provider: "github-copilot", host: "github.com", label: "Copilot", usedPercent: 0, resetsAt: new Date(), windowSeconds: 0, usedValue: 0, limitValue: 0 },
  ];

  it("narrows copilot windows to the given host", () => {
    const filtered = filterWindowsForHost("github-copilot", "github.com", copilotWindows);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].host).toBe("github.com");
  });

  it("returns all windows when no host is given", () => {
    expect(filterWindowsForHost("github-copilot", undefined, copilotWindows)).toHaveLength(2);
  });

  it("returns all windows for non-copilot providers regardless of host", () => {
    expect(filterWindowsForHost("anthropic", "github.com", copilotWindows)).toHaveLength(2);
    expect(filterWindowsForHost("openai-codex", undefined, copilotWindows)).toHaveLength(2);
  });

  it("returns all windows when provider is undefined", () => {
    expect(filterWindowsForHost(undefined, "github.com", copilotWindows)).toHaveLength(2);
  });
});
