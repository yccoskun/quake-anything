# Changelog

All notable changes to Quake Anything are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- GNOME Shell 51 support.

## [1.0.1] - 2026-08-25

### Fixed

- Spawned windows are no longer lost when the session is suspended. Window IDs,
  live size percentages, and monitor placements now persist across the
  disable/enable cycle that suspend triggers.
- Windows are reclaimed on enable without replaying the show animation, so a
  resumed session comes back to the layout it had.
- Stale window IDs and unmanaged windows are cleaned out of the persistent state
  instead of leaking.

### Added

- `version-name` in `metadata.json`, so extensions.gnome.org shows a semantic
  version rather than only the review sequence number.

## [1.0.0] - 2026-08-02

Initial release on [extensions.gnome.org](https://extensions.gnome.org/extension/10596/quake-anything/).

### Added

- Dock any installed GUI app to the **top**, **bottom**, **left**, or **right**
  edge of the screen, Quake-style.
- Multiple entries, each with its own application, edge, keyboard shortcut, and
  size.
- Default size expressed as a **percentage** of the monitor work area (10–90%),
  so the layout survives moving between monitors of different resolutions.
- First spawn lands on the monitor under the mouse pointer; later toggles
  restore the docked position and size.
- Free movement while visible — move, resize, minimize, or maximize the window;
  the next shortcut press snaps it back to its Quake position.
- Only windows spawned by the extension are controlled. Other windows of the
  same application are left alone.
- Preferences dialog with shortcut capture (Esc cancels, Backspace clears) and
  conflict warnings against existing GNOME shortcuts.
- GNOME Shell 46–50 support.

[Unreleased]: https://github.com/yccoskun/quake-anything/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/yccoskun/quake-anything/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/yccoskun/quake-anything/releases/tag/v1.0.0
