import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  QUOTAS_CONFIG_UPDATED_EVENT,
  QUOTAS_EXTENSIONS_REGISTER_EVENT,
  QUOTAS_EXTENSIONS_REQUEST_EVENT,
  type QuotasConfigUpdatedPayload,
  configLoader,
} from "../../config.js";
import { fetchProviderQuotas, filterWindowsForHost, isSupportedProvider, resolveActiveQuotaProvider, resolveActiveQuotaProviderHost } from "../../lib/quotas.js";
import {
  assessWindow,
  formatTimeRemaining,
  type RiskSeverity,
} from "../../utils/quotas-severity.js";

export const QUOTA_WARNING_COOLDOWN_MS = 60 * 60 * 1000;
const MIN_FETCH_INTERVAL_MS = 30_000;

const SEVERITY_ORDER: RiskSeverity[] = ["none", "warning", "high", "critical"];

type AlertState = { lastSeverity: RiskSeverity; lastNotifiedAt: number };
const alertState = new Map<string, AlertState>();
let lastFetchAt = 0;
let pendingCheck: Promise<void> | null = null;
let lastProvider: string | undefined = undefined;

export function shouldNotify(key: string, severity: RiskSeverity, now = Date.now()): boolean {
  if (severity === "none") return false;
  const current = alertState.get(key);
  if (!current) return true;
  if (SEVERITY_ORDER.indexOf(severity) > SEVERITY_ORDER.indexOf(current.lastSeverity)) return true;
  return now - current.lastNotifiedAt >= QUOTA_WARNING_COOLDOWN_MS;
}

export function markNotified(key: string, severity: RiskSeverity, now = Date.now()): void {
  alertState.set(key, { lastSeverity: severity, lastNotifiedAt: now });
}

export function clearAlertState(): void {
  alertState.clear();
  lastFetchAt = 0;
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  let enabled = configLoader.getConfig().quotaWarnings;
  let currentContext: ExtensionContext | undefined;
  async function check(ctx: ExtensionContext, onlyNew: boolean): Promise<void> {
    const provider = resolveActiveQuotaProvider(ctx.model?.provider, ctx.model?.id);
    if (!ctx.hasUI || !provider || !isSupportedProvider(provider)) return;
    const now = Date.now();
    if (onlyNew && now - lastFetchAt < MIN_FETCH_INTERVAL_MS) return;
    lastFetchAt = now;

    const result = await fetchProviderQuotas(ctx.modelRegistry.authStorage, provider);
    if (!result.success) return;

    const host = resolveActiveQuotaProviderHost(ctx.model?.id);
    const windows = filterWindowsForHost(provider, host, result.data.windows);
    const risky = windows
      .map((window) => ({ window, assessment: assessWindow(window) }))
      .filter((entry) => entry.assessment.severity !== "none");
    if (risky.length === 0) return;

    const toNotify = onlyNew
      ? risky.filter((entry) => shouldNotify(`${provider}:${entry.window.label}`, entry.assessment.severity))
      : risky;
    if (toNotify.length === 0) return;

    for (const entry of toNotify) {
      markNotified(`${provider}:${entry.window.label}`, entry.assessment.severity);
    }

    const providerName = provider === "openai-codex"
      ? "Codex"
      : provider === "github-copilot"
        ? "GitHub Copilot"
        : "Anthropic";

    const lines = toNotify.map(({ window, assessment }) => {
      const projected = Math.round(assessment.projectedPercent);
      const used = Math.round(window.usedPercent);
      return `- ${window.label}: ${used}% used, projected ${projected}% (${assessment.severity}), resets in ${formatTimeRemaining(window.resetsAt)}`;
    });

    const level = toNotify.some((entry) => entry.assessment.severity === "critical" || entry.assessment.severity === "high")
      ? "error"
      : "warning";
    ctx.ui.notify(`${providerName} quota warning:\n${lines.join("\n")}`, level);
  }

  function scheduleCheck(ctx: ExtensionContext, onlyNew: boolean): void {
    const next = (pendingCheck ?? Promise.resolve())
      .then(() => check(ctx, onlyNew))
      .catch(() => {
        // Quota warnings are opportunistic; never let a failed quota check block Pi events.
      });
    pendingCheck = next;
  }

  pi.events.on(QUOTAS_CONFIG_UPDATED_EVENT, (data: unknown) => {
    const wasEnabled = enabled;
    enabled = (data as QuotasConfigUpdatedPayload).config.quotaWarnings;
    if (!enabled) {
      clearAlertState();
      return;
    }
    // Only clear and re-check on disabled→enabled transition, not on every event
    if (!wasEnabled && currentContext) {
      clearAlertState();
      scheduleCheck(currentContext, false);
    }
  });

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    clearAlertState();
    if (!enabled) return;
    scheduleCheck(ctx, false);
  });

  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    if (!enabled) return;
    scheduleCheck(ctx, true);
  });

  pi.on("model_select", async (_event, ctx) => {
    const provider = resolveActiveQuotaProvider(ctx.model?.provider, ctx.model?.id);
    const providerChanged = provider !== lastProvider;
    lastProvider = provider;
    currentContext = ctx;
    if (providerChanged) {
      clearAlertState();
    }
  });

  pi.on("session_shutdown", async () => {
    currentContext = undefined;
    clearAlertState();
  });

  pi.events.on(QUOTAS_EXTENSIONS_REQUEST_EVENT, () => {
    if (configLoader.getConfig().quotaWarnings) {
      pi.events.emit(QUOTAS_EXTENSIONS_REGISTER_EVENT, { feature: "quotaWarnings" });
    }
  });
}
