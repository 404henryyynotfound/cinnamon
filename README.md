# cinnamon

**cinnamon** is a local-first **computer task manager / system monitor** for Linux, macOS and Windows. It watches what your machine is actually doing — processes, CPU, memory, disk, network — and gives you calm, explainable control over it. It is not a to-do list: its "tasks" are the work your computer is performing and the rules you set to keep it healthy.

The package description in `package.json` still says "desktop task manager"; in this project that means **managing computer tasks and system load**, not personal to-dos.

## What it does

- **Live processes** — a sortable, searchable table of every process with CPU, memory, resident bytes, user, uptime, state and full command line, with a flat or parent/child tree view.
- **More than ending tasks** — pause (`SIGSTOP`) and resume (`SIGCONT`) processes, interrupt (`SIGINT`) them, ask them to shut down (`SIGTERM`), force-stop (`SIGKILL`), change niceness (`setPriority`), inspect process details and Linux `/proc/<pid>/fd` open files, and pin processes you want to follow. Destructive actions always require confirmation from shared metadata and are logged locally.
- **Pinned processes** — followed PIDs persist in local storage, show live status when present and are flagged as "not running" when they leave a sample.
- **Process reports** — deterministic JSON, CSV and Markdown reports with top CPU/memory, groups by user and state, totals and local AI findings. The Processes view and command palette can export the current table as CSV or Markdown.
- **Terminal CLI** — the zero-dependency `cinnamon-cli` command (`cinnamon-cli`, alias `cinn`), bundled in `cinnamon-gui`, brings `ps`, `top`, `kill`, `renice`, `pause`, `resume`, `report` and `diagnose` to any terminal. It is offline and cross-platform: `/proc` on Linux, safely parsed `ps` elsewhere, with mandatory `--yes` confirmation for process changes.
- **Inline SVG performance graphs** — CPU, memory, disk and network history, process bars, a memory donut and a weekday/hour activity heatmap. No chart library, no CDN.
- **Explainable local AI diagnostics** — deterministic findings for CPU hogs, runaway processes, memory and disk pressure, network spikes, zombies, load and long uptime, each with evidence and suggested actions.
- **Optional BYOK AI** — ask an OpenAI-compatible endpoint of your choosing for a second opinion. Requests happen only when you press **Ask AI**, use your own key, have a 10 second timeout, and always fall back to the local diagnosis on failure.
- **Watch rules** — process or system thresholds with cooldowns, severities and a persistent alert history.
- **Local JSON storage** — settings, rules, alerts, pinned processes and the action log live in one atomically written file in the app's user-data directory. Export and import are available in Settings; pinned PIDs survive a backup/merge without duplicates.
- **Changelogs** — an in-app bundled changelog that works offline, plus public GitHub release notes fetched on demand. Both are available under **Changelog** in the sidebar and in the command palette.

## Install

Pick the route that suits your machine. The display name is always lowercase `cinnamon`; the npm package `cinnamon-gui` installs both the GUI launcher and the `cinnamon-cli` command, and the Snap name is `cinnamon-tasks`. The [website](site/index.html) has a **Download for every platform** section with direct latest-release links.

```bash
# npm launcher: detects OS/arch, verifies SHA-256 and starts the app
npm i -g cinnamon-gui
cinnamon
cinnamon --dry-run     # show the selected asset without downloading

# terminal CLI: offline process inspection and control
npm i -g cinnamon-gui
cinnamon-cli ps --sort cpu --limit 10
cinnamon-cli report --format markdown
cinnamon-cli kill 4242 SIGTERM --yes

# Debian package downloaded from the releases page (arm64 for Raspberry Pi)
sudo apt install ./cinnamon-linux-x64.deb

# Snap
sudo snap install cinnamon-tasks
cinnamon-tasks
```

Tagged releases publish assets for every supported combination, each with a `.sha256` companion:

| Platform | x64 | arm64 |
| --- | --- | --- |
| Linux | `.deb`, `.tar.gz` | `.deb`, `.tar.gz` |
| macOS | `.dmg`, `.zip` | `.dmg`, `.zip` |
| Windows | `.exe` (NSIS), `.zip` | `.exe` (NSIS), `.zip` |

Release archives follow `cinnamon-${os}-${arch}.${ext}`, for example `cinnamon-linux-x64.deb`, `cinnamon-macos-arm64.dmg` or `cinnamon-windows-arm64.zip`. All downloads come from `https://github.com/404henryyynotfound/cinnamon/releases/latest`. Pi-Apps definitions are available for Raspberry Pi users.

## Develop

```bash
cd cinnamon
npm install          # dev dependencies only: Electron and electron-builder
npm start            # launch the app from source
npm test                       # pure Node tests, no Electron required
npm run check                  # syntax and packaging-config check
npm test --prefix npm/launcher # launcher asset-selection tests
npm test --prefix npm/cli      # CLI tests with injected processes
npm run dist:linux-x64
npm run dist:linux-arm64
```

The renderer is plain CommonJS-style browser JavaScript with no bundler or framework. All system access goes through an allow-listed `contextBridge` IPC surface; the main process validates PIDs, signals, operation names, report formats and URLs. System sampling uses only Node built-ins (`os`, `fs`, `child_process`) and never executes shell commands.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + K` | Command palette (also `Ctrl/Cmd + N`) |
| `Ctrl/Cmd + 1…7` | Overview, Processes, Performance, AI, Watchers, Changelog, Settings |
| `Ctrl/Cmd + ,` | Settings |
| `Ctrl/Cmd + Shift + R` | Refresh the sample now |
| `Ctrl/Cmd + Shift + T` | Toggle light/dark theme |
| `Esc` | Close a dialog |

The command palette includes both changelog tabs (**Changelog: In app** and **Changelog: GitHub releases**) and CSV/Markdown process report exports.

## Changelogs

- **[CHANGELOG.md](CHANGELOG.md)** — the Keep-a-Changelog style file shipped with the source. A copy lives at `ui/CHANGELOG.md` so the packaged app can parse and display it completely offline. It documents 1.0.0 with Added, Changed and Fixed sections.
- **GitHub releases** — the Changelog view's **GitHub** tab fetches `https://api.github.com/repos/404henryyynotfound/cinnamon/releases` on demand, without authentication. If the network or GitHub is unavailable, the tab clearly says so and falls back to the bundled notes.

Both views render the same structured release format; bundled notes take precedence when a version appears in both sources.

## Privacy

No account, telemetry or background network calls. Local diagnostics and all charts are computed on your device. BYOK requests go directly from cinnamon to the endpoint you configure, only when you ask, and API keys are masked in the UI and never logged. The GitHub tab is the only other network feature and only runs when you open that tab and choose to fetch releases.

## License

MIT — see [LICENSE](LICENSE).
