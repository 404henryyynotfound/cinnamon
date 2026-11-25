# Changelog

All notable changes to cinnamon, a local-first computer task manager, are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Cross-platform tagged releases: Linux x64/arm64 `.deb` and `.tar.gz`, macOS x64/arm64 `.dmg` and `.zip`, and Windows x64/arm64 NSIS `.exe` and `.zip`, each with a `.sha256` companion and normalized asset names.
- `cinnamon-cli`: a zero-dependency, offline terminal companion with `ps`, `top`, `kill`, `renice`, `pause`, `resume`, `report`, `diagnose`, `--version` and `--help`. PIDs, signals and priorities are validated and every process change requires `--yes`; Linux uses `/proc` and other platforms use safely parsed `ps`.
- A **Download for every platform** section on the website with direct latest-release links, copy buttons, Snap, npm launcher/CLI and Pi-Apps routes.

### Changed

- The npm launcher reads overridable environment targets so `--dry-run` can verify all six OS/architecture asset selections without downloading.
- Electron packaging now uses a single lowercase "computer task manager" description and never auto-publishes; the release job uploads only regular files with retries.
- The bundled and source changelogs are kept in sync so offline release notes include these additions.

## [1.0.0] - 2026-11-25

### Added

- Live process table with sorting, search, CPU, memory, uptime, state and full command line, refreshed on a configurable interval.
- Safe process actions: `SIGTERM`, `SIGKILL`, `SIGINT`, `SIGSTOP` and `SIGCONT`, plus `renice`, with confirmation metadata and a persistent action log.
- Expanded process controls: named `pause`, `resume`, `interrupt`, `terminate`, `kill` and `setPriority` operations, Linux `/proc/<pid>/fd` open-file inspection, a flat/tree toggle and pinned processes that stay visible across refreshes.
- Pure process reports serialized as JSON, CSV and Markdown with top CPU/memory, groups by user and state, totals and local AI findings; current-table exports are available from the Processes view and command palette.
- Inline SVG performance graphs for CPU, memory, disk and network history, process bars, a memory donut and a weekday/hour activity heatmap.
- Explainable local AI diagnostics that rank findings such as CPU hogs, runaway processes, memory and disk pressure, network spikes, zombie processes and long uptime, with evidence and suggested actions.
- Optional BYOK AI second opinion using any OpenAI-compatible endpoint, with strict JSON responses, a 10 second timeout and automatic fallback to local diagnostics.
- Watch rules with thresholds, cooldowns and an alert history for processes and system metrics.
- In-app Changelog view with bundled release notes and on-demand GitHub release notes, plus an offline fallback.
- Light and dark themes, command palette, keyboard shortcuts, single-instance launch and an optional tray icon.

### Changed

- All data is stored locally in a single atomic JSON file; pinned processes are included in backup/import and merge without duplicates, and no account, telemetry or background network calls are required.
- System sampling and all parsing/analysis logic are pure and testable without Electron, using only Node built-ins.
- The renderer communicates with Electron exclusively through an allow-listed `contextBridge` IPC surface.

### Fixed

- Missing or unavailable `ps`, `df` or `/proc/net/dev` no longer break sampling; parsers return empty data instead of throwing.
- Network rates are computed from counter deltas instead of absolute values, avoiding misleading spikes after a restart.
- BYOK failures never leak API keys into error messages or logs and always fall back to local AI results.
