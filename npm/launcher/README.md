# cinnamon-gui

Launcher for the [cinnamon](https://github.com/404henryyynotfound/cinnamon) computer task manager.

```bash
npm install -g cinnamon-gui
cinnamon
```

The launcher detects your OS and CPU, downloads the matching public release archive from GitHub, verifies its published SHA-256 checksum, caches it under `~/.cinnamon/<version>/` (`CINNAMON_HOME` overrides this), and starts the app. It has no runtime dependencies.

```bash
cinnamon --dry-run     # show the selected release asset and cache path
cinnamon --version     # launcher version
```

Supported release assets are `cinnamon-linux-{x64,arm64}.tar.gz`,
`cinnamon-macos-{x64,arm64}.zip` and `cinnamon-windows-{x64,arm64}.zip`
(each with a `.sha256` companion). Debian packages and the other installer
formats are published alongside them for every tagged release.

For testing or scripting, `CINNAMON_PLATFORM`, `CINNAMON_ARCH` and
`CINNAMON_VERSION` override detection; `--dry-run` never downloads anything:

```bash
CINNAMON_PLATFORM=darwin CINNAMON_ARCH=arm64 cinnamon --dry-run
```
