import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    computeQuakeRect,
    getPointerMonitorIndex,
    percentFromRect,
    slideOffsetForSide,
} from './geometry.js';
import type { QuakeEntry } from './types.js';

const ANIM_MS = 180;
const CLAIM_TIMEOUT_MS = 8000;

interface PendingClaim {
    entryId: string;
    appId: string;
    timeoutId: number;
}

function unmaximizeCompat(win: Meta.Window): void {
    const w = win as Meta.Window & {
        unmaximize?: (flags?: Meta.MaximizeFlags) => void;
        set_unmaximize_flags?: (flags: Meta.MaximizeFlags) => void;
        get_maximize_flags?: () => Meta.MaximizeFlags;
        maximized_horizontally?: boolean;
        maximized_vertically?: boolean;
    };

    if (typeof w.get_maximize_flags === 'function') {
        const flags = w.get_maximize_flags() as number;
        if (flags !== 0) {
            if (typeof w.unmaximize === 'function') {
                try {
                    w.unmaximize();
                    return;
                } catch {
                    // fall through
                }
            }
            if (typeof w.set_unmaximize_flags === 'function')
                w.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
            else if (typeof w.unmaximize === 'function')
                w.unmaximize(Meta.MaximizeFlags.BOTH);
        }
        return;
    }

    if (w.maximized_horizontally || w.maximized_vertically) {
        if (typeof w.unmaximize === 'function')
            w.unmaximize(Meta.MaximizeFlags?.BOTH ?? 3);
    }
}

export class QuakeManager {
    private _entries = new Map<string, QuakeEntry>();
    private _windows = new Map<string, Meta.Window>();
    private _livePercent = new Map<string, number>();
    private _lastMonitor = new Map<string, number>();
    private _pending: PendingClaim | null = null;
    private _windowCreatedId = 0;
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
        for (const id of [...this._windows.keys()])
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
        for (const entry of entries)
            this._entries.set(entry.id, entry);
        // Do not snap visible windows — free placement stays until the next shortcut show.
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

        // Shortcut always hides when visible; next press restores quake geometry.
        if (this._isVisible(win))
            this._hide(entryId, win, entry);
        else
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

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._pending || this._pending.entryId !== pending.entryId)
                return GLib.SOURCE_REMOVE;

            if (!this._windowMatchesPending(win, pending.appId)) {
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

        const actor = win.get_compositor_private() as Clutter.Actor | null;
        const place = () => {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._windows.get(entryId) !== win)
                    return GLib.SOURCE_REMOVE;
                this._applyQuakeGeometry(entryId, win, entry, true);
                this._show(entryId, win, entry);
                return GLib.SOURCE_REMOVE;
            });
        };

        if (actor) {
            const id = actor.connect('first-frame', () => {
                actor.disconnect(id);
                place();
            });
        } else {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                place();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _detachWindow(entryId: string, resetSessionState: boolean): void {
        this._windows.delete(entryId);
        this._animating.delete(entryId);
        if (resetSessionState) {
            this._livePercent.delete(entryId);
            this._lastMonitor.delete(entryId);
        }
    }

    private _effectivePercent(entryId: string, entry: QuakeEntry): number {
        return this._livePercent.get(entryId) ?? entry.sizePercent;
    }

    /** Snapshot size % along the docked axis for the next quake show. */
    private _rememberQuakePercent(entryId: string, win: Meta.Window, entry: QuakeEntry): void {
        const frame = win.get_frame_rect();
        const monitor = win.get_monitor();
        const percent = percentFromRect(
            entry.side,
            { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
            monitor,
        );
        this._livePercent.set(entryId, percent);
        this._lastMonitor.set(entryId, monitor);
    }

    private _applyQuakeGeometry(
        entryId: string,
        win: Meta.Window,
        entry: QuakeEntry,
        usePointerMonitor: boolean,
    ): void {
        const percent = this._effectivePercent(entryId, entry);
        const monitor = usePointerMonitor
            ? getPointerMonitorIndex()
            : (this._lastMonitor.get(entryId) ?? win.get_monitor());
        const rect = computeQuakeRect(entry.side, percent, monitor);

        unmaximizeCompat(win);

        if (win.get_monitor() !== monitor)
            win.move_to_monitor(monitor);

        const workspace = global.workspace_manager.get_active_workspace();
        if (!win.located_on_workspace(workspace))
            win.change_workspace(workspace);

        win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
        this._lastMonitor.set(entryId, monitor);
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

        if (win.minimized)
            win.unminimize();

        // Shortcut show always restores docked quake layout (not free-float position).
        this._applyQuakeGeometry(entryId, win, entry, false);

        win.activate(global.get_current_time());

        const actor = win.get_compositor_private() as Clutter.Actor | null;
        if (!actor)
            return;

        const rect = computeQuakeRect(
            entry.side,
            this._effectivePercent(entryId, entry),
            this._lastMonitor.get(entryId) ?? win.get_monitor(),
        );
        const offset = slideOffsetForSide(entry.side, rect);
        actor.remove_all_transitions();
        actor.set_translation(offset.x, offset.y, 0);
        this._animating.add(entryId);
        actor.ease({
            translationX: 0,
            translationY: 0,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                this._animating.delete(entryId);
            },
        });
    }

    private _hide(entryId: string, win: Meta.Window, entry: QuakeEntry): void {
        if (this._animating.has(entryId))
            return;

        // Preserve size % / monitor for next quake show; leave free-float until then.
        this._rememberQuakePercent(entryId, win, entry);

        const actor = win.get_compositor_private() as Clutter.Actor | null;
        actor?.remove_all_transitions();
        actor?.set_translation(0, 0, 0);
        this._animating.delete(entryId);

        win.minimize();
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
            const info = GioUnix.DesktopAppInfo.new(desktopId);
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
