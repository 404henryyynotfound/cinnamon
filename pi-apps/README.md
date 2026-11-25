# Pi-Apps entry for cinnamon

`cinnamon/` is a ready-made [Pi-Apps](https://pi-apps.io/) definition for 64-bit ARM Raspberry Pi systems. Its `install-64` script downloads the arm64 `.deb` from the matching GitHub Release, verifies SHA-256, and installs it with Pi-Apps' `install_packages` helper. `uninstall` uses `purge_packages`, keeping local settings.

## Import without waiting for official inclusion

1. Install Pi-Apps from <https://pi-apps.io/install/>.
2. Open **Pi-Apps Settings → Import app**.
3. Import `cinnamon.zip` from this folder (or the copy attached to the GitHub Release).
4. Find **cinnamon** under Imported and install it.

Rebuild the zip after editing the app definition:

```bash
cd pi-apps
zip -qr cinnamon.zip cinnamon
```

## Official submission

Copy `cinnamon/` into `apps/` of a Pi-Apps fork, add `cinnamon|Office` to `etc/categories`, keep scripts executable, and open a pull request against `Botspot/pi-apps` following their CONTRIBUTING guide.
