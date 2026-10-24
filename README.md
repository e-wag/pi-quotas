# @latentminds/pi-quotas

Quota monitoring for Pi. Shows remaining usage and rate limits for Anthropic, OpenAI Codex, GitHub Copilot, OpenRouter, and Synthetic — directly in your Pi session.

## Screenshots


| `/quotas` dashboard | Footer status |
| ------------------- | ------------- |
| Quotas dashboard    | Footer status |


## Install

**From npm** (recommended):

```bash
pi install npm:@latentminds/pi-quotas
```

**From source:**

```bash
git clone https://github.com/latentminds-ai/pi-quotas.git
pi install ./pi-quotas
```

**Try without installing:**

```bash
pi -e npm:@latentminds/pi-quotas
```

## Commands


| Command              | Description                                |
| -------------------- | ------------------------------------------ |
| `/quotas`            | Combined quota dashboard for all providers |
| `/anthropic:quotas`  | Anthropic quotas only                      |
| `/codex:quotas`      | OpenAI Codex quotas only                   |
| `/github:quotas`     | GitHub Copilot quotas only                 |
| `/openrouter:quotas` | OpenRouter quotas only                     |
| `/synthetic:quotas`  | Synthetic quotas only                      |
| `/quotas:settings`   | Toggle individual features on or off       |


## Features

### Quota dashboard

Run `/quotas` to open a bordered TUI view showing all providers side by side, with progress bars, used/remaining counts, and reset times. Press `r` to refresh, `q` or `Esc` to close.

### Footer status widget

When your active model is from a supported provider, the Pi footer shows real-time quota headroom - updated every 60 seconds and on each turn. Colours shift from green → amber → red as usage climbs.

### Quota warnings

Automatic notifications when projected usage is on track to exceed limits before the window resets. Warnings escalate from `warning` → `high` → `critical` based on your consumption pace.

### Per-feature toggles

Use `/quotas:settings` to enable or disable:

- Combined `/quotas` command
- Per-provider commands (`/anthropic:quotas`, `/codex:quotas`, `/github:quotas`, `/openrouter:quotas`, `/synthetic:quotas`)
- Footer status widget
- Quota warning notifications
- **Defer to Synthetic** — when both pi-quotas and [pi-synthetic](https://www.npmjs.com/package/@aliou/pi-synthetic) are loaded, pi-quotas hides its own Synthetic footer to avoid showing duplicate quota information. Enabled by default; disable if you prefer to see both footers.

Settings can be saved globally (`~/.pi/agent/extensions/quotas.json`) or per-project (`.pi/quotas.json`). Run `/reload` after changing command visibility.

## Supported providers


| Provider       | Windows                                                        | Details                                                                                             |
| -------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Anthropic      | 5h, 7d, per-model 7d, extra usage                              | Utilization percentages; optional overage budget in local currency                                  |
| OpenAI Codex   | 5h, 7d, credits, spend cap                                     | Rate-limit percentages; credit balance; spend-cap reached/OK                                        |
| GitHub Copilot | Premium/chat/completions per month                             | Remaining/entitlement counts with overage indicators                                                |
| OpenRouter     | Monthly budget, daily/weekly/monthly usage                     | USD spending tracking with cents precision; optional per-key budget limits; UTC-based period resets |
| Synthetic      | Subscription, search/hour, free tools, weekly tokens, 5h limit | Request counts and token budgets; rolling five-hour rate limit; weekly token regen                  |


## Proxy providers

If you route models through a proxy or gateway (for example a local gateway that multiplexes several upstream subscriptions), the active model's `provider` will be the proxy's provider id, not one of the supported providers above. pi-quotas can still show the right widget by routing on the model id prefix.

Add a `providerPrefixes` map to `~/.pi/agent/extensions/quotas.json` (or per-project `.pi/quotas.json`):

```json
{
  "providerPrefixes": {
    "my-copilot/": "github-copilot",
    "my-codex/": "openai-codex",
    "my-openrouter/": "openrouter"
  }
}
```

Keys are matched against the start of the active model's id; the longest matching prefix wins. When the active provider is already a supported provider, it takes precedence over the prefix map. The map is empty by default, so nothing is routed unless you configure it.

For the GitHub Copilot provider, older Pi versions that expose raw auth credentials read the quota host from the `enterpriseUrl` field of the `github-copilot` entry (default `github.com`). Current Pi versions do not expose that field through ModelRegistry; configure an Enterprise host on a `providerPrefixes` entry, for example `"my-copilot/": {"provider": "github-copilot", "host": "ghe.example.com"}`. The `PI_QUOTAS_COPILOT_HOSTS` environment variable overrides the set of hosts queried and can include a comma-separated list for multiple subscriptions. The API call uses the `gh` CLI.

## Credentials

pi-quotas resolves provider API keys through Pi's model registry, with the older AuthStorage API used when available:

- `anthropic` — Anthropic OAuth token
- `openai-codex` — Codex access token; the account ID comes from legacy Pi auth metadata when available, otherwise `~/.codex/auth.json`
- `github-copilot` — authenticated `gh` CLI (`gh api`)
- `openrouter` — OpenRouter API key (Bearer token)
- `synthetic` — Synthetic API key (set the `SYNTHETIC_API_KEY` environment variable)

No additional API key setup is required when Pi exposes the provider credential. Codex quota checks also need an account ID from legacy Pi auth metadata or `~/.codex/auth.json`. For Synthetic, export `SYNTHETIC_API_KEY`; GitHub Copilot checks use the authenticated `gh` CLI.

## Requirements

- [Pi](https://github.com/mariozechner/pi) >= 0.61.0

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes and recent changes.

## License

[MIT](LICENSE) © Latent Minds Pty Ltd

## Acknowledgements

This project was inspired by [@aliou/pi-synthetic](https://www.npmjs.com/package/@aliou/pi-synthetic).

