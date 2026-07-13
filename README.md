# Quake Anything

GNOME Shell extension that docks any GUI app to a screen edge (top, bottom, left, or right) and toggles it with a keyboard shortcut — Quake-style, for any application.

## Requirements

- GNOME Shell 45–50 (developed for GNOME 50 / Fedora 44)
- [Bun](https://bun.sh/) (build only)

## Build & install

```bash
bun install
make install
```

Then log out and back in (Wayland), and enable the extension:

```bash
gnome-extensions enable quake-anything@yccoskun.github.io
```

Open **Extensions** → **Quake Anything** → **Settings** to add apps.

## Configure

For each entry, set:

1. **Application** — any installed GUI app
2. **Side** — top / bottom / left / right
3. **Keyboard shortcut** — set in a GNOME Settings–style dialog (Esc cancels, Backspace disables; conflicts are warned)
4. **Default size** — percentage of the monitor work area

## Behavior notes

- Windows appear on the monitor under the pointer.
- Only windows spawned by the extension are controlled.
- Owned windows stay edge-docked (no free move / minimize / maximize); you can resize along the free edge. The resized percentage is remembered until the app process exits, then the settings default applies again.
- Monitor moves preserve the size **ratio**.
