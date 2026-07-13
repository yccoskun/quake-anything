import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import type Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    computeQuakeRect,
    getPointerMonitorIndex,
    slideOffsetForSide,
} from './geometry.js';
import type { QuakeEntry, QuakeSide } from './types.js';
import { WindowConstraints, unmaximizeCompat } from './window-constraints.js';

const ANIM_MS = 180;
const CLAIM_TIMEOUT_MS = 8000;

interface PendingClaim {
    entryId: string;
    appId: string;
    timeoutId: number;
}

export class QuakeManager {
    private _entries = new Map<string, QuakeEntry>();
    private _windows = new Map<string, Meta.Window>();
    private _livePercent = new Map<string, number>();
    private _lastMonitor = new Map<string, number>();
    private _constraints = new Map<string, WindowConstraints>();
    private _pending: PendingClaim | null = null;
    private _windowCreatedId = 0;
    private _hiding = new Set<string>();
    private _animating = new Set<string>();

    enable(): void {
        this._windowCreatedId = global.display.connect(
            'window-created',
            (_d, win) => this._onWindowCreated(win),
        );
    }

    disable(): void {
        if (this._windowCreatedId) {
            global.display.disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
        this._clearPending();
        for (const id of [...this._constraints.keys()])
            this._detachWindow(id, false);
        this._entries.clear();
        this._livePercent.clear();
        this._lastMonitor.clear();
    }

    setEntries(entries: QuakeEntry[]): void {
        const nextIds = new Set(entries.map(e => e.id));
        for (const id of [...this._entries.keys()]) {
            if (!nextIds.has(id)) {
                this._detachWindow(id, false);
                this._livePercent.delete(id);
                this._lastMonitor.delete(id);
            }
        }

        this._entries.clear();
        for (const entry of entries) {
            this._entries.set(entry.id, entry);
            const constraints = this._constraints.get(entry.id);
            if (constraints)
                constraints.updateSide(entry.side);
            const win = this._windows.get(entry.id);
            if (win && this._isVisible(win))
                this._applyGeometry(entry.id, win, entry, false);
        }
    }

    getEntry(id: string): QuakeEntry | undefined {
        return this._entries.get(id);
    }

    toggle(entryId: string): void {
        const entry = this._entries.get(entryId);
        if (!entry)
            return;

        const win = this._windows.get(entryId);
        if (!win || win.get_compositor_private() == null) {
            this._windows.delete(entryId);
            this._spawn(entry);
            return;
        }

        if (this._isVisible(win)) {
            if (win.has_focus())
                this._hide(entryId, win, entry.side);
            else
                this._show(entryId, win, entry);
            return;
        }

        this._show(entryId, win, entry);
    }

    private _spawn(entry: QuakeEntry): void {
        const app = this._resolveApp(entry.appId);
        if (!app) {
            Main.notify('Quake Anything', `Could not find app: ${entry.appId}`);
            return;
        }

        this._clearPending();
        this._pending = {
            entryId: entry.id,
            appId: this._normalizeAppId(entry.appId),
            timeoutId: GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLAIM_TIMEOUT_MS, () => {
                if (this._pending?.entryId === entry.id) {
                    Main.notify('Quake Anything', `Timed out waiting for ${entry.appId}`);
                    this._pending = null;
                }
                return GLib.SOURCE_REMOVE;
            }),
        };

        try {
            if (app.can_open_new_window()) {
                app.open_new_window(-1);
            } else {
                const workspace = global.workspace_manager.get_active_workspace_index();
                app.launch(global.get_current_time(), workspace, Shell.AppLaunchGpu.APP_PREF);
            }
        } catch (e) {
            this._clearPending();
            Main.notify('Quake Anything', `Failed to launch ${entry.appId}`);
            console.error('[quake-anything] launch failed', e);
        }
    }

    private _onWindowCreated(win: Meta.Window): void {
        const pending = this._pending;
        if (!pending)
            return;

        // Defer until WindowTracker maps the window to an app.
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._pending || this._pending.entryId !== pending.entryId)
                return GLib.SOURCE_REMOVE;

            if (!this._windowMatchesPending(win, pending.appId)) {
                // Retry shortly — app association can lag behind window-created.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                    if (!this._pending || this._pending.entryId !== pending.entryId)
                        return GLib.SOURCE_REMOVE;
                    if (this._windowMatchesPending(win, pending.appId))
                        this._claimWindow(pending.entryId, win);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            }

            this._claimWindow(pending.entryId, win);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _windowMatchesPending(win: Meta.Window, appId: string): boolean {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (!app)
            return false;
        return this._normalizeAppId(app.get_id()) === this._normalizeAppId(appId);
    }

    private _claimWindow(entryId: string, win: Meta.Window): void {
        const entry = this._entries.get(entryId);
        if (!entry)
            return;

        this._clearPending();

        // Only one owned window per entry.
        const existing = this._windows.get(entryId);
        if (existing && existing !== win)
            this._detachWindow(entryId, false);

        this._windows.set(entryId, win);
        this._livePercent.delete(entryId);
        this._lastMonitor.delete(entryId);

        win.connect('unmanaged', () => {
            if (this._windows.get(entryId) === win)
                this._detachWindow(entryId, true);
        });

        const constraints = new WindowConstraints(win, {
            side: entry.side,
            getPercent: () => this._effectivePercent(entryId, entry),
            setPercent: percent => this._livePercent.set(entryId, percent),
            getMonitorIndex: () => win.get_monitor(),
            reapplyGeometry: () => this._applyGeometry(entryId, win, entry, false),
        });
        this._constraints.set(entryId, constraints);

        const actor = win.get_compositor_private() as Clutter.Actor | null;
        if (actor) {
            const id = actor.connect('first-frame', () => {
                actor.disconnect(id);
                this._applyGeometry(entryId, win, entry, true);
                this._show(entryId, win, entry);
            });
        } else {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._applyGeometry(entryId, win, entry, true);
                this._show(entryId, win, entry);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _detachWindow(entryId: string, resetLivePercent: boolean): void {
        const constraints = this._constraints.get(entryId);
        if (constraints) {
            constraints.destroy();
            this._constraints.delete(entryId);
        }
        this._windows.delete(entryId);
        this._hiding.delete(entryId);
        this._animating.delete(entryId);
        if (resetLivePercent) {
            this._livePercent.delete(entryId);
            this._lastMonitor.delete(entryId);
        }
    }

    private _effectivePercent(entryId: string, entry: QuakeEntry): number {
        return this._livePercent.get(entryId) ?? entry.sizePercent;
    }

    private _applyGeometry(
        entryId: string,
        win: Meta.Window,
        entry: QuakeEntry,
        usePointerMonitor: boolean,
    ): void {
        const percent = this._effectivePercent(entryId, entry);
        let monitor: number;
        if (usePointerMonitor) {
            monitor = getPointerMonitorIndex();
        } else if (!win.minimized) {
            // Keep wherever the window currently is (e.g. moved by another tool).
            monitor = win.get_monitor();
        } else {
            // After hide, restore the monitor we remembered before minimize.
            monitor = this._lastMonitor.get(entryId) ?? win.get_monitor();
        }
        const rect = computeQuakeRect(entry.side, percent, monitor);

        const constraints = this._constraints.get(entryId);
        constraints?.setSuspended(true);
        try {
            unmaximizeCompat(win);

            if (win.get_monitor() !== monitor)
                win.move_to_monitor(monitor);

            const workspace = global.workspace_manager.get_active_workspace();
            if (!win.located_on_workspace(workspace))
                win.change_workspace(workspace);

            win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
            this._lastMonitor.set(entryId, monitor);

            try {
                win.make_above();
            } catch {
                // ignore if unsupported
            }
            try {
                win.stick();
            } catch {
                // optional
            }
        } finally {
            // Keep suspended briefly so deferred size/position signals settle.
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                constraints?.setSuspended(false);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _isVisible(win: Meta.Window): boolean {
        if (win.minimized)
            return false;
        const actor = win.get_compositor_private() as Clutter.Actor | null;
        if (!actor || !actor.visible)
            return false;
        return true;
    }

    private _show(entryId: string, win: Meta.Window, entry: QuakeEntry): void {
        if (this._animating.has(entryId))
            return;

        this._hiding.delete(entryId);

        if (win.minimized)
            win.unminimize();

        // First spawn places on the pointer monitor in _claimWindow.
        // Later show/hide cycles stay on the window's last monitor.
        this._applyGeometry(entryId, win, entry, false);

        win.activate(global.get_current_time());

        const actor = win.get_compositor_private() as Clutter.Actor | null;
        if (!actor) {
            return;
        }

        const rect = computeQuakeRect(
            entry.side,
            this._effectivePercent(entryId, entry),
            win.get_monitor(),
        );
        const offset = slideOffsetForSide(entry.side, rect);
        actor.remove_all_transitions();
        actor.set_translation(offset.x, offset.y, 0);
        this._animating.add(entryId);
        actor.ease({
            translation_x: 0,
            translation_y: 0,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: (_isFinished: boolean) => {
                this._animating.delete(entryId);
            },
        });
    }

    private _hide(entryId: string, win: Meta.Window, side: QuakeSide): void {
        if (this._animating.has(entryId) || this._hiding.has(entryId))
            return;

        // Remember monitor before minimize so show restores the same screen.
        this._lastMonitor.set(entryId, win.get_monitor());

        const actor = win.get_compositor_private() as Clutter.Actor | null;
        if (!actor) {
            win.minimize();
            return;
        }

        const frame = win.get_frame_rect();
        const offset = slideOffsetForSide(side, {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
        });

        this._hiding.add(entryId);
        this._animating.add(entryId);
        actor.remove_all_transitions();
        actor.ease({
            translation_x: offset.x,
            translation_y: offset.y,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            onStopped: (isFinished: boolean) => {
                this._animating.delete(entryId);
                if (isFinished && this._hiding.has(entryId)) {
                    win.minimize();
                    actor.set_translation(0, 0, 0);
                    this._hiding.delete(entryId);
                }
            },
        });
    }

    private _resolveApp(appId: string): Shell.App | null {
        const context = Shell.AppSystem.get_default();
        const raw = appId.trim();
        const candidates = [
            raw,
            raw.endsWith('.desktop') ? raw : `${raw}.desktop`,
            raw.replace(/\.desktop$/i, ''),
        ];

        for (const id of candidates) {
            const app = context.lookup_app(id);
            if (app)
                return app;
        }

        try {
            const desktopId = raw.endsWith('.desktop') ? raw : `${raw}.desktop`;
            const info = Gio.DesktopAppInfo.new(desktopId);
            if (info) {
                const id = info.get_id();
                if (id) {
                    const app = context.lookup_app(id);
                    if (app)
                        return app;
                }
            }
        } catch {
            // ignore
        }
        return null;
    }

    private _normalizeAppId(appId: string): string {
        return appId.trim().replace(/\.desktop$/i, '').toLowerCase();
    }

    private _clearPending(): void {
        if (this._pending?.timeoutId)
            GLib.source_remove(this._pending.timeoutId);
        this._pending = null;
    }
}
