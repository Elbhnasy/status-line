# status-line

One package for my existing statuslines across CLI agents. Each CLI gets the statusline I already
use, installed the way that CLI loads it. The only behavior change is the **usage** segment: it
reports the quota numbers the provider actually publishes, instead of a rounded percentage of a
single window (and, for Hermes, instead of a percentage of a made-up token budget).

## Install on any device

You need Node.js 18+:

```bash
npx @ktarek/status-line all
```

`all` installs the statusline for every supported CLI it finds on the device (Claude Code, agy,
Hermes, OpenCode) and skips the ones that aren't installed. Restart those CLIs afterwards.

The package was first published as `@elbhnasy/status-line`, which stays at 0.1.0 and is no longer
updated; use `@ktarek/status-line`. Installing over a 0.1.0 install needs no cleanup.

To install for a single CLI:

```bash
npx @ktarek/status-line claude
npx @ktarek/status-line agy
npx @ktarek/status-line hermes
npx @ktarek/status-line opencode
```

Add `--dry-run` to see what would change, or `--uninstall` to revert, e.g.
`npx @ktarek/status-line all --uninstall`. `list` shows each CLI's mechanism, and `--help`
prints usage. Running straight from GitHub also works (needs git):
`npx github:Elbhnasy/status-line all`.

## What each command installs

| CLI | Statusline | How the CLI loads it |
|---|---|---|
| `claude` | `statuslines/claude/statusline.js`: `dir │ model │ effort │ context: bar % │ usage: <windows> │ task` | `statusLine` command in `~/.claude/settings.json` → `~/.claude/hooks/statusline.js` |
| `agy` | `statuslines/agy/statusline.js`: `dir │ model │ context: bar %`, **plus** `│ usage: <windows>` | `statusLine` command (`enabled: true`) in `~/.gemini/antigravity-cli/settings.json` → `hooks/statusline.js` |
| `hermes` | `statuslines/hermes/statusbar-claude.patch`: Claude-style layout for the Hermes status bar, with the provider's real account-usage windows | Source patch applied to the hermes-agent git checkout, then `hermes config set display.status_bar.style claude` |
| `opencode` | `statuslines/opencode/statusline.tsx`: `dir │ model │ effort │ context: bar %` | TUI plugin listed in `~/.config/opencode/tui.json` → `plugins/statusline.tsx` |

Every config edit keeps all other keys and writes a `<file>.status-line-backup-<timestamp>` copy first.
What changed is recorded in `~/.status-line/manifest.json`, and `--uninstall` uses that record.
Re-running an install is a no-op once everything is in place.

## The usage segment

What the segment shows, in every CLI:

1. **Only numbers a source published.** Where a provider publishes a subscription window as a
   fraction (Anthropic, Google) that fraction *is* the real value; no token or dollar magnitude is
   invented for it. Dollars appear only where the source exposes them (a Claude apps gateway's
   `spend_limit`, Anthropic's `extra_usage`), and they are printed as sent — a $12.50 limit is not
   rounded to $13.
2. **Every window that source publishes**, each labelled: the 5-hour **and** the weekly limit, not
   just one of them. A window keeps its label even when it is the only one live, so a survivor can
   never be mistaken for a different window.
3. **The bar follows the 5-hour window** until a weekly window reaches 90%; from then on it follows
   the most-used window. A weekly budget is far larger than a 5-hour one, so a higher weekly
   percentage does not mean it runs out first until it is nearly spent. The bar's window is printed
   first, with its label in front of the bar and its number after it. (Hermes never gives the bar
   to a model-scoped week such as `opus wk`, since it cannot exhaust the account.) On a narrow
   terminal the secondary windows are given up before the whole segment is.
4. **Real precision:** one decimal below 10%, an integer at or above, and the integer always comes
   from the published number. `1.5603%` reads `1.6%` (never `2%`), `0.26%` reads `0.3%` (never
   `0%`), and `12.46%` reads `12%` (never `13%`).
5. **A window past its reset is dropped**, exactly as Claude Code drops it. With no live window left
   the segment disappears (or, in Hermes, falls back to the session's real token total: `Σ790K tok`).
6. **Nothing is shown stale without saying so:** an unrefreshed value is dimmed with its age.

Examples: `usage: 5h ░░░░░░░░░░ 1.0% (4h4m) · wk 3.0% (1d9h)`, and once the week is nearly
spent `usage: wk █████████░ 92% (1d9h) · 5h 20% (2h14m)`.

### Agy usage bar

`agy -p "/usage" --output-format json` reports quota per model group (Gemini; Claude and GPT),
each with a 5-hour and a weekly bucket. The segment shows **both buckets of the active model's
group**, at the precision the payload gives (`remaining_fraction` is all it publishes).

That call takes about 5 seconds, so the statusline never waits for it. It reads
`~/.gemini/antigravity-cli/cache/status-line-usage.json`, and when that file is older than a
minute it starts a detached `statusline.js --refresh-usage` to update it.
- Until the first refresh lands, the line is exactly the original Agy line.
- A value older than 10 minutes is dimmed and shown with its age.
- A bucket whose window has reset is dropped; when both have, the segment is hidden.

Set `STATUS_LINE_AGY_BIN` if `agy` is not on `PATH`.

### Claude Code usage bar

Source order: Claude Code's stdin `rate_limits` (5-hour + weekly, plus a gateway `spend_limit`) →
a 3-minute shared cache (`~/.claude/cache/usage-cache-v3.json`) → the OAuth usage API (with 429
backoff; it also carries the model-scoped `seven_day_opus`/`seven_day_sonnet` windows) → the cache
shown dimmed with its age. When the source publishes no subscription window at all (an API-key
session, or a subscriber before the first API response) the segment is omitted rather than faked.

### Hermes

Hermes has no hook for an external statusline command, so its statusline is a patch to Hermes
itself, cut against upstream commit `statuslines/hermes/BASE`.

The `usage:` segment reads Hermes' own account-usage cache
(`agent.account_usage_cache.cached_account_usage`) — the Anthropic/Codex/OpenRouter windows
`hermes /usage` already fetches — and asks for a throttled background refresh instead of blocking a
repaint. The provider is re-read on every repaint, so the bar works before the first turn creates
the agent and follows a `/model` switch. Until the first snapshot lands (a second or so after the
first turn) it shows the session's real token total. The retired `display.status_bar.usage_budget`
key is unset by the installer and no longer read.

The patch also fixes `agent/account_usage.py`, which scaled Anthropic `utilization` values ≤ 1 by
100 — a 1% session rendered as a full bar (the endpoint reports percentages: `five_hour.utilization`
and `limits[].percent` agree). That fix reaches `hermes /usage` too.

Installing over a previous version works without cleanup: when the packaged patch does not apply,
the installer reverses the patch it recorded last time (`~/.status-line/hermes-statusbar-claude.patch`)
and applies the new one over the result.

The installer first tries a plain `git apply`. If that fails, it tries a 3-way merge against a
throwaway index, so a patch that would conflict is refused and the checkout is left untouched.
`hermes update` autostashes local changes and re-applies them; if that ever fails, re-run
`status-line hermes`.

The patch covers the classic CLI status bar only, not `tui_gateway`.

## Development

```bash
npm test                    # statusline goldens, installers, CLI
npm run test:integration    # Hermes's own status bar suites on a patched BASE export
npm run check-drift         # packaged statuslines vs. the live ones on this machine
```

- `test/fixtures/golden/*.json` holds recorded stdout for every case in `test/fixtures/cases.js`,
  recorded with `scripts/record-goldens.js` (from the original scripts when one is imported, from
  the packaged script after an intentional behaviour change here).
- `test/fixtures/usage-cases.js` is the shared real-usage contract: it drives both the Claude and the
  agy suite, so the two standalone scripts cannot drift apart on window labels, precision or expiry.
  (They stay standalone files because each installer copies exactly one file into place.)
- The Claude script is **no longer byte-identical** to the original at
  `~/.claude/hooks/statusline.js` — showing both real rate-limit windows is the point of this change.
  It is pinned by sha256 as a tripwire against accidental edits, and the OpenCode file is still
  pinned to the original.
- `npm run test:integration` resolves a Hermes interpreter that can import pytest (override with
  `STATUS_LINE_HERMES_PYTHON`) and fails rather than silently skipping when it cannot find one.

The Claude script credits https://github.com/TahaSabir0/claude-statusline, and that attribution
is kept.
