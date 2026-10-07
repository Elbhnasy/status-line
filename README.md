# status-line

One package for my existing statuslines across CLI agents. Each CLI gets the statusline I already
use, installed the way that CLI loads it. The only behavior change is the **usage** segment: it
reports the quota numbers the provider actually publishes, instead of a rounded percentage of a
single window (and, for Hermes, instead of a percentage of a made-up token budget).

## Install on any device

You need Node.js 18+:

```bash
npx @elbhnasy/status-line all
```

`all` installs the statusline for every supported CLI it finds on the device (Claude Code, agy,
Hermes, OpenCode) and skips the ones that aren't installed. Restart those CLIs afterwards.

To install for a single CLI:

```bash
npx @elbhnasy/status-line claude
npx @elbhnasy/status-line agy
npx @elbhnasy/status-line hermes
npx @elbhnasy/status-line opencode
```

Add `--dry-run` to see what would change, or `--uninstall` to revert, e.g.
`npx @elbhnasy/status-line all --uninstall`. `list` shows each CLI's mechanism, and `--help`
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
   `spend_limit`, Anthropic's `extra_usage`, OpenRouter credits).
2. **Every window that source publishes**, each labelled: the 5-hour **and** the weekly limit, not
   just one of them.
3. **The bar is drawn from the binding window** (the live window with the highest usage) and its
   number is always printed next to it.
4. **Real precision:** one decimal below 10%, an integer at or above. `1.5603%` reads `1.6%`, never
   `2%`; `0.26%` reads `0.3%`, never `0%`.
5. **A window past its reset is dropped**, exactly as Claude Code drops it. With no live window left
   the segment disappears (or, in Hermes, falls back to the session's real token total: `Σ790K tok`).
6. **Nothing is shown stale without saying so:** an unrefreshed value is dimmed with its age.

Examples: `usage: ░░░░░░░░░░ wk 3.0% (1d9h) · 5h 1.0% (4h4m)`.

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
backoff) → the cache shown dimmed with its age. With an API key (`ANTHROPIC_API_KEY`) there are no
subscription windows to show, so the segment is omitted rather than faked.

### Hermes

Hermes has no hook for an external statusline command, so its statusline is a patch to Hermes
itself, cut against upstream commit `statuslines/hermes/BASE`.

The `usage:` segment reads Hermes' own account-usage cache
(`agent.account_usage_cache.cached_account_usage`) — the Anthropic/Codex/OpenRouter windows
`hermes /usage` already fetches — and asks for a throttled background refresh instead of blocking a
repaint. Until the first snapshot lands (about a second after startup) it shows the session's real
token total. The retired `display.status_bar.usage_budget` key is unset by the installer and no
longer read.

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
