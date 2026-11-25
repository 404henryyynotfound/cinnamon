# Changelog

All notable changes to cinnamon, a local-first computer task manager, are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-25

### Added

- Live process table with sorting, search, CPU, memory, uptime, state and full command line, refreshed on a configurable interval.
- Safe process actions: `SIGTERM`, `SIGKILL`, `SIGINT`, `SIGSTOP` and `SIGCONT`, plus `renice`, with confirmation metadata and a persistent action log.
- Inline SVG performance graphs for CPU, memory, disk and network history, process bars, a memory donut and a weekday/hour activity heatmap.
- Explainable local AI diagnostics that rank findings such as CPU hogs, runaway processes, memory and disk pressure, network spikes, zombie processes and long uptime, with evidence and suggested actions.
- Optional BYOK AI second opinion using any OpenAI-compatible endpoint, with strict JSON responses, a 10 second timeout and automatic fallback to local diagnostics.
- Watch rules with thresholds, cooldowns and an alert history for processes and system metrics.
- In-app Changelog view with bundled release notes and on-demand GitHub release notes, plus an offline fallback.
- Light and dark themes, command palette, keyboard shortcuts, single-instance launch and an optional tray icon.

### Changed

- All data is stored locally in a single atomic JSON file; no account, telemetry or background network calls are required.
- System sampling and all parsing/analysis logic are pure and testable without Electron, using only Node built-ins.
- The renderer communicates with Electron exclusively through an allow-listed `contextBridge` IPC surface.

### Fixed

- Missing or unavailable `ps`, `df` or `/proc/net/dev` no longer break sampling; parsers return empty data instead of throwing.
- Network rates are computed from counter deltas instead of absolute values, avoiding misleading spikes after a restart.
- BYOK failures never leak API keys into error messages or logs and always fall back to local AI results.
