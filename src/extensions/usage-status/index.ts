import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  QUOTAS_CONFIG_UPDATED_EVENT,
  QUOTAS_EXTENSIONS_REGISTER_EVENT,
  QUOTAS_EXTENSIONS_REQUEST_EVENT,
  type QuotasConfigUpdatedPayload,
  configLoader,
} from "../../config.js";

/** Event emitted by pi-synthetic when its usage-status extension registers. */
const SYNTHETIC_EXTENSIONS_REGISTER_EVENT = "synthetic:extensions:register";
interface SyntheticExtensionsRegisterPayload {
  feature: string;
}
import {
  fetchProviderQuotas,
  filterWindowsForHost,
  isSupportedProvider,
  resolveActiveQuotaProvider,
  resolveActiveQuotaProviderHost,
} from "../../lib/quotas.js";
import {
  assessWindow,
  formatTimeRemaining,
} from "../../utils/quotas-severity.js";
import type { QuotaWindow } from "../../types/quotas.js";
import { formatWindowStatus, type WindowStatus } from "./format-status.js";

const EXTENSION_ID = "pi-quotas-usage";
const REFRESH_INTERVAL_MS = 60_000;

function formatCopilotResetTime(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return "now";
  const totalMins = Math.ceil(ms / (1000 * 60));
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
  }
  if (hours >= 1) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  return `${totalMins}m`;
}

function formatFooterResetTime(resetsAt: string, provider?: string): string {
  if (provider === "github-copilot") return formatCopilotResetTime(resetsAt);
  const remaining = formatTimeRemaining(new Date(resetsAt));
  return remaining === "now" ? "now" : `in ${remaining}`;
}

function assessStatusSeverity(window: QuotaWindow): ReturnType<typeof assessWindow>["severity"] {
  if (window.provider !== "github-copilot") return assessWindow(window).severity;
  const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
  if (remainingPercent <= 5) return "critical";
  if (remainingPercent <= 10) return "high";
  if (remainingPercent <= 20) return "warning";
  return "none";
}

export function formatStatus(ctx: Pick<ExtensionContext, "ui">, windows: WindowStatus[]): string {
  const theme = ctx.ui.theme;
  return windows
    .map((w) => {
      const core = formatWindowStatus(theme, w);
      const reset = w.resetsAt ? theme.fg("dim", ` (↺${formatFooterResetTime(w.resetsAt, w.provider)})`) : "";
      return `${core}${reset}`;
    })
    .join(" ");
}

const ANTHROPIC_SUBSCRIPTION_WINDOW_LABELS = new Set([
  "5h",
  "7d",
  "7d Sonnet",
  "7d Opus",
  "7d Opus (legacy)",
]);

function shouldShowInStatus(window: QuotaWindow): boolean {
  return !(
    window.provider === "anthropic" &&
    ANTHROPIC_SUBSCRIPTION_WINDOW_LABELS.has(window.label)
  );
}

export function toWindowStatus(window: QuotaWindow): WindowStatus {
  return {
    provider: window.provider,
    label: window.label,
    usedPercent: window.usedPercent,
    severity: assessStatusSeverity(window),
    resetsAt: window.resetsAt.getTime() > 0 ? window.resetsAt.toISOString() : null,
    limited: window.limited ?? false,
    isCurrency: window.isCurrency,
    usedValue: window.usedValue,
    limitValue: window.limitValue,
  };
}

export function toStatusWindows(windows: QuotaWindow[]): WindowStatus[] {
  return windows.filter(shouldShowInStatus).map(toWindowStatus);
}

export function formatStatusForFooter(
  ctx: Pick<ExtensionContext, "ui">,
  windows: WindowStatus[],
): string | undefined {
  if (windows.length === 0) return undefined;
  return formatStatus(ctx, windows);
}

function createStatusRefresher() {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let activeContext: ExtensionContext | undefined;
  let activeProvider: string | undefined;
  let lastStatus: WindowStatus[] | undefined;
  let inFlight = false;
  let queued = false;

  function isStaleContextError(error: unknown): boolean {
    return error instanceof Error && error.message.toLowerCase().includes("extension ctx is stale");
  }

  function clearState(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
    activeContext = undefined;
    activeProvider = undefined;
    lastStatus = undefined;
    queued = false;
  }

  async function update(ctx: ExtensionContext): Promise<void> {
    try {
      if (!ctx.hasUI || !activeProvider || !isSupportedProvider(activeProvider)) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const result = await fetchProviderQuotas(ctx.modelRegistry.authStorage, activeProvider);
        if (!result.success) {
          ctx.ui.setStatus(EXTENSION_ID, ctx.ui.theme.fg("warning", "usage unavailable"));
          return;
        }
        const host = resolveActiveQuotaProviderHost(ctx.model?.id);
        const windows: WindowStatus[] = toStatusWindows(
          filterWindowsForHost(activeProvider, host, result.data.windows),
        );
        const status = formatStatusForFooter(ctx, windows);
        lastStatus = status === undefined ? undefined : windows;
        ctx.ui.setStatus(EXTENSION_ID, status);
      } catch (error) {
        if (isStaleContextError(error)) {
          clearState();
          return;
        }
        ctx.ui.setStatus(EXTENSION_ID, ctx.ui.theme.fg("warning", "usage unavailable"));
      } finally {
        inFlight = false;
        if (queued) {
          queued = false;
          void update(ctx);
        }
      }
    } catch (error) {
      if (isStaleContextError(error)) clearState();
      else throw error;
    }
  }

  return {
    async refreshFor(ctx: ExtensionContext): Promise<void> {
      activeContext = ctx;
      activeProvider = resolveActiveQuotaProvider(ctx.model?.provider, ctx.model?.id);
      if (!activeProvider || !isSupportedProvider(activeProvider)) {
        ctx.ui.setStatus(EXTENSION_ID, undefined);
        return;
      }
      await update(ctx);
    },
    start(): void {
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        if (activeContext) void update(activeContext);
      }, REFRESH_INTERVAL_MS);
      refreshTimer.unref?.();
    },
    stop(ctx?: ExtensionContext): void {
      clearState();
      try {
        ctx?.ui.setStatus(EXTENSION_ID, undefined);
      } catch (error) {
        if (!isStaleContextError(error)) throw error;
      }
    },
    renderLast(ctx: ExtensionContext): boolean {
      try {
        if (!lastStatus || !ctx.hasUI) return false;
        ctx.ui.setStatus(EXTENSION_ID, formatStatusForFooter(ctx, lastStatus));
        return true;
      } catch (error) {
        if (!isStaleContextError(error)) throw error;
        clearState();
        return false;
      }
    },
  };
}

export default async function (pi: ExtensionAPI) {
  await configLoader.load();
  const refresher = createStatusRefresher();
  let enabled = configLoader.getConfig().usageStatus;
  let deferToSynthetic = configLoader.getConfig().deferToSynthetic;
  let currentContext: ExtensionContext | undefined;

  /** Whether pi-synthetic's usage footer is active in this session. */
  let syntheticUsageActive = false;

  pi.events.on(SYNTHETIC_EXTENSIONS_REGISTER_EVENT, (data: unknown) => {
    const { feature } = data as SyntheticExtensionsRegisterPayload;
    if (feature !== "usageStatus") return;
    syntheticUsageActive = true;
    if (!currentContext || !enabled || !deferToSynthetic) return;

    try {
      // If currently showing synthetic data, clear our footer.
      if (currentContext.model?.provider === "synthetic") {
        currentContext.ui.setStatus(EXTENSION_ID, undefined);
        refresher.stop();
      }
    } catch (error) {
      if (!isStaleContextError(error)) throw error;
      currentContext = undefined;
      refresher.stop();
    }
  });

  function isStaleContextError(error: unknown): boolean {
    return error instanceof Error && error.message.toLowerCase().includes("extension ctx is stale");
  }

  function scheduleRefresh(ctx: ExtensionContext): void {
    void refresher.refreshFor(ctx).catch((error) => {
      if (isStaleContextError(error)) return;
      try {
        if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, ctx.ui.theme.fg("warning", "usage unavailable"));
      } catch (statusError) {
        if (!isStaleContextError(statusError)) throw statusError;
      }
    });
  }

  pi.events.on(QUOTAS_CONFIG_UPDATED_EVENT, (data: unknown) => {
    const config = (data as QuotasConfigUpdatedPayload).config;
    enabled = config.usageStatus;
    deferToSynthetic = config.deferToSynthetic;
    if (!enabled) {
      refresher.stop(currentContext);
      return;
    }
    if (currentContext) {
      refresher.start();
      scheduleRefresh(currentContext);
    }
  });

  /**
   * Whether to suppress our footer because pi-synthetic is showing
   * the same data for the Synthetic provider.
   */
  function shouldDeferToSynthetic(provider: string | undefined): boolean {
    return deferToSynthetic && syntheticUsageActive && provider === "synthetic";
  }

  pi.on("session_start", (_event, ctx) => {
    currentContext = ctx;
    if (!enabled) return;
    if (shouldDeferToSynthetic(ctx.model?.provider)) {
      ctx.ui.setStatus(EXTENSION_ID, undefined);
      return;
    }
    refresher.start();
    scheduleRefresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    currentContext = ctx;
    if (!enabled) return;
    if (shouldDeferToSynthetic(ctx.model?.provider)) return;
    scheduleRefresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    currentContext = ctx;
    if (!enabled) {
      refresher.stop(ctx);
      return;
    }
    if (shouldDeferToSynthetic(ctx.model?.provider)) {
      ctx.ui.setStatus(EXTENSION_ID, undefined);
      return;
    }
    scheduleRefresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    currentContext = undefined;
    syntheticUsageActive = false;
    refresher.stop(ctx);
  });

  pi.events.on(QUOTAS_EXTENSIONS_REQUEST_EVENT, () => {
    if (configLoader.getConfig().usageStatus) {
      pi.events.emit(QUOTAS_EXTENSIONS_REGISTER_EVENT, { feature: "usageStatus" });
    }
  });
}
