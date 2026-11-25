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

The page fetches public GitHub releases for the changelog section and falls back to bundled notes offline.
