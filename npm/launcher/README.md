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
