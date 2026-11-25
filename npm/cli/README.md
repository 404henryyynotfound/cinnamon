# cinnamon-cli

An offline, zero-dependency command-line companion to the [cinnamon](https://github.com/404henryyynotfound/cinnamon) computer task manager. It inspects and controls the same computer tasks as the GUI, from a terminal, on Linux, macOS and Windows.

```bash
npm install -g cinnamon-cli
cinnamon-cli --help
# `cinn` is a short alias
```

No account, no telemetry and no downloads at runtime. Only Node.js built-ins are used.

## Commands

| Command | What it does |
| --- | --- |
| `cinnamon-cli ps` | List processes with PID, parent, user, state, CPU, memory, RSS, uptime and command. `--sort cpu\|memory\|pid\|name`, `--limit N`, `--format table\|json\|csv`. |
| `cinnamon-cli top` | Repeatedly sample the busiest processes. `--interval SECONDS`, `--count N`, `--limit N`. |
| `cinnamon-cli kill <pid...> [signal]` | Send an allow-listed signal (`SIGTERM` by default). `--yes` required. |
| `cinnamon-cli pause <pid...>` | Send `SIGSTOP`. `--yes` required. |
| `cinnamon-cli resume <pid...>` | Send `SIGCONT`. `--yes` required. |
| `cinnamon-cli renice <pid> <priority>` | Set niceness from `-20` to `19` (not supported on Windows). `--yes` required. |
| `cinnamon-cli report` | Print a deterministic JSON, CSV or Markdown process report with totals, top CPU/memory and local findings. |
| `cinnamon-cli diagnose` | Explainable local findings such as CPU hogs, memory pressure and zombie processes. `--format text\|json`. |
| `cinnamon-cli --version` / `--help` | Version and usage. |

Examples:

```bash
cinnamon-cli ps --sort memory --limit 10
cinnamon-cli top --interval 2 --count 5
cinnamon-cli report --format markdown > report.md
cinnamon-cli diagnose --format json
cinnamon-cli kill 4242 SIGTERM --yes
cinnamon-cli pause 4242 --yes
cinnamon-cli renice 4242 10 --yes
```

## Safety

- PIDs must be positive integers; signals are limited to `SIGTERM`, `SIGKILL`, `SIGINT`, `SIGSTOP` and `SIGCONT`; priorities must be integers from `-20` to `19`.
- Every process-changing command requires `--yes`. Without it, the command exits with code `2` and performs no action.
- Signals use `process.kill`. `renice` uses `execFile` with numeric arguments. No shell string is ever built or executed.
- Process sampling reads `/proc` on Linux and falls back to `ps` through `execFile` on macOS, Windows and other platforms. Output is parsed with strict regular expressions; malformed rows are skipped.

## Tests

```bash
npm test
```

Tests use injected process readers, signal senders and clocks. They never inspect, signal or renice a real process.
