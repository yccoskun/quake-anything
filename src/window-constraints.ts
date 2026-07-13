import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import type { QuakeSide } from './types.js';
import { percentFromRect, type Rect } from './geometry.js';

export interface ConstrainedWindowOptions {
    side: QuakeSide;
    getPercent: () => number;
    setPercent: (percent: number) => void;
    getMonitorIndex: () => number;
    reapplyGeometry: () => void;
}

function isMoveOp(op: Meta.GrabOp): boolean {
    return op === Meta.GrabOp.MOVING
        || op === Meta.GrabOp.MOVING_UNCONSTRAINED
        || op === Meta.GrabOp.KEYBOARD_MOVING;
}

function isResizeOp(op: Meta.GrabOp): boolean {
    return op === Meta.GrabOp.RESIZING_NW
        || op === Meta.GrabOp.RESIZING_N
        || op === Meta.GrabOp.RESIZING_NE
        || op === Meta.GrabOp.RESIZING_E
        || op === Meta.GrabOp.RESIZING_SW
        || op === Meta.GrabOp.RESIZING_S
        || op === Meta.GrabOp.RESIZING_SE
        || op === Meta.GrabOp.RESIZING_W
        || op === Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN
        || op === Meta.GrabOp.KEYBOARD_RESIZING_NW
        || op === Meta.GrabOp.KEYBOARD_RESIZING_N
        || op === Meta.GrabOp.KEYBOARD_RESIZING_NE
        || op === Meta.GrabOp.KEYBOARD_RESIZING_E
        || op === Meta.GrabOp.KEYBOARD_RESIZING_SW
        || op === Meta.GrabOp.KEYBOARD_RESIZING_S
        || op === Meta.GrabOp.KEYBOARD_RESIZING_SE
        || op === Meta.GrabOp.KEYBOARD_RESIZING_W;
}

function isAllowedResizeForSide(side: QuakeSide, op: Meta.GrabOp): boolean {
    switch (side) {
    case 'top':
        return op === Meta.GrabOp.RESIZING_S || op === Meta.GrabOp.KEYBOARD_RESIZING_S;
    case 'bottom':
        return op === Meta.GrabOp.RESIZING_N || op === Meta.GrabOp.KEYBOARD_RESIZING_N;
    case 'left':
        return op === Meta.GrabOp.RESIZING_E || op === Meta.GrabOp.KEYBOARD_RESIZING_E;
    case 'right':
        return op === Meta.GrabOp.RESIZING_W || op === Meta.GrabOp.KEYBOARD_RESIZING_W;
    }
}

export function unmaximizeCompat(win: Meta.Window): void {
    const w = win as Meta.Window & {
        unmaximize?: (flags?: Meta.MaximizeFlags) => void;
        set_unmaximize_flags?: (flags: Meta.MaximizeFlags) => void;
        get_maximize_flags?: () => Meta.MaximizeFlags;
        maximized_horizontally?: boolean;
        maximized_vertically?: boolean;
    };

    if (typeof w.get_maximize_flags === 'function') {
        // Meta.MaximizeFlags has no NONE; 0 means not maximized.
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

export class WindowConstraints {
    private _win: Meta.Window;
    private _opts: ConstrainedWindowOptions;
    private _signals: number[] = [];
    private _displaySignals: number[] = [];
    private _applying = false;
    private _lastMonitor: number;
    private _resizing = false;
    private _reapplySource = 0;

    constructor(win: Meta.Window, opts: ConstrainedWindowOptions) {
        this._win = win;
        this._opts = opts;
        this._lastMonitor = win.get_monitor();
        this._connect();
    }

    updateSide(side: QuakeSide): void {
        this._opts.side = side;
    }

    setSuspended(suspended: boolean): void {
        this._applying = suspended;
    }

    destroy(): void {
        if (this._reapplySource) {
            GLib.source_remove(this._reapplySource);
            this._reapplySource = 0;
        }
        for (const id of this._signals)
            this._win.disconnect(id);
        this._signals = [];
        for (const id of this._displaySignals)
            global.display.disconnect(id);
        this._displaySignals = [];
    }

    private _connect(): void {
        this._displaySignals.push(
            global.display.connect('grab-op-begin', (_d, win, op) => {
                if (win !== this._win)
                    return;
                if (isMoveOp(op)) {
                    this._scheduleReapply();
                    return;
                }
                if (isResizeOp(op)) {
                    if (!isAllowedResizeForSide(this._opts.side, op)) {
                        this._scheduleReapply();
                        return;
                    }
                    this._resizing = true;
                }
            }),
        );

        this._displaySignals.push(
            global.display.connect('grab-op-end', (_d, win, op) => {
                if (win !== this._win)
                    return;
                if (this._resizing && isResizeOp(op)) {
                    this._resizing = false;
                    this._rememberPercentFromFrame();
                    this._scheduleReapply();
                } else if (isMoveOp(op)) {
                    this._scheduleReapply();
                }
            }),
        );

        this._signals.push(
            this._win.connect('notify::maximized-horizontally', () => this._onMaximizeChanged()),
        );
        this._signals.push(
            this._win.connect('notify::maximized-vertically', () => this._onMaximizeChanged()),
        );
        this._signals.push(
            this._win.connect('size-changed', () => {
                if (this._applying || this._resizing)
                    return;
                this._rememberPercentFromFrame();
            }),
        );
        this._signals.push(
            this._win.connect('position-changed', () => {
                if (this._applying || this._resizing)
                    return;
                const monitor = this._win.get_monitor();
                if (monitor !== this._lastMonitor) {
                    this._lastMonitor = monitor;
                    this._scheduleReapply();
                } else if (!this._win.minimized) {
                    this._scheduleReapply();
                }
            }),
        );
    }

    private _onMaximizeChanged(): void {
        if (this._applying)
            return;
        unmaximizeCompat(this._win);
        this._scheduleReapply();
    }

    private _rememberPercentFromFrame(): void {
        const frame = this._win.get_frame_rect();
        const rect: Rect = {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
        };
        const monitor = this._win.get_monitor();
        const percent = percentFromRect(this._opts.side, rect, monitor);
        this._opts.setPercent(percent);
    }

    private _scheduleReapply(): void {
        if (this._reapplySource)
            return;
        this._reapplySource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            this._reapplySource = 0;
            this._applying = true;
            try {
                unmaximizeCompat(this._win);
                this._opts.reapplyGeometry();
                this._lastMonitor = this._win.get_monitor();
            } finally {
                this._applying = false;
            }
            return GLib.SOURCE_REMOVE;
        });
    }
}
