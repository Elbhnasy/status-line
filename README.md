# status-line

One package for my existing statuslines across CLI agents. Each CLI gets the statusline I already
use, installed the way that CLI loads it. Nothing is redesigned; the only behavior change is a
usage bar for Agy, which had none.

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
| `claude` | `statuslines/claude/statusline.js`: `dir │ model │ effort │ context: bar % │ usage: bar % (reset) │ task` | `statusLine` command in `~/.claude/settings.json` → `~/.claude/hooks/statusline.js` |
| `agy` | `statuslines/agy/statusline.js`: `dir │ model │ context: bar %`, **plus** `│ usage: bar % (reset)` | `statusLine` command (`enabled: true`) in `~/.gemini/antigravity-cli/settings.json` → `hooks/statusline.js` |
| `hermes` | `statuslines/hermes/statusbar-claude.patch`: Claude-style layout for the Hermes status bar | Source patch applied to the hermes-agent git checkout, then `hermes config set display.status_bar.style claude` and `usage_budget 1000000` |
| `opencode` | `statuslines/opencode/statusline.tsx`: `dir │ model │ effort │ context: bar %` | TUI plugin listed in `~/.config/opencode/tui.json` → `plugins/statusline.tsx` |

Every config edit keeps all other keys and writes a `<file>.status-line-backup-<timestamp>` copy first.
What changed is recorded in `~/.status-line/manifest.json`, and `--uninstall` uses that record.
Re-running an install is a no-op once everything is in place.

### Agy usage bar

`agy -p "/usage" --output-format json` reports quota per model group (Gemini; Claude and GPT),
each with a 5-hour and a weekly bucket. The bar shows the **5-hour bucket of the active model's
group**, in the same format as the Claude bar.

That call takes about 5 seconds, so the statusline never waits for it. It reads
`~/.gemini/antigravity-cli/cache/status-line-usage.json`, and when that file is older than a
minute it starts a detached `statusline.js --refresh-usage` to update it.
- Until the first refresh lands, the line is exactly the original Agy line.
- A value older than 10 minutes is dimmed and shown with its age.
- Once its 5-hour window has reset, the value is hidden.

Set `STATUS_LINE_AGY_BIN` if `agy` is not on `PATH`.

### Hermes

Hermes has no hook for an external statusline command, so its statusline is a patch to Hermes
itself, cut against upstream commit `statuslines/hermes/BASE`.

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

- `test/fixtures/golden/*.json` holds the stdout of the **original** Claude and Agy scripts for
  every case in `test/fixtures/cases.js`, recorded with `scripts/record-goldens.js`.
- The packaged Claude script must reproduce its goldens exactly, and so must the Agy script
  whenever it has no usage data.
- The Claude and OpenCode files are also pinned by sha256.

The Claude script credits https://github.com/TahaSabir0/claude-statusline, and that attribution
is kept.
