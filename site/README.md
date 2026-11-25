# cinnamon landing page

Static, dependency-free site for the cinnamon computer task manager.

Preview locally:

```bash
cd cinnamon/site
python3 -m http.server 8080
```

Deploy from the `cinnamon/` directory:

```bash
npx surge ./site cinnamon-tasks.surge.sh
```

The page links directly to the latest tagged release assets for Linux, macOS and Windows (x64 and arm64), plus Snap, npm and Pi-Apps, and fetches public GitHub releases for the changelog section with bundled notes as an offline fallback.
