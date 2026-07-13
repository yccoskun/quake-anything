import type { QuakeSide } from './types.js';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export function getPointerMonitorIndex(): number {
    const [x, y] = global.get_pointer();
    const display = global.display;
    const n = display.get_n_monitors();
    for (let i = 0; i < n; i++) {
        const geo = display.get_monitor_geometry(i);
        if (x >= geo.x && x < geo.x + geo.width && y >= geo.y && y < geo.y + geo.height)
            return i;
    }
    return display.get_current_monitor();
}

export function getWorkAreaForMonitor(monitorIndex: number): Rect {
    const workspace = global.workspace_manager.get_active_workspace();
    const area = workspace.get_work_area_for_monitor(monitorIndex);
    return {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
    };
}

export function computeQuakeRect(
    side: QuakeSide,
    percent: number,
    monitorIndex: number,
): Rect {
    const work = getWorkAreaForMonitor(monitorIndex);
    const p = Math.min(90, Math.max(10, percent)) / 100;

    switch (side) {
    case 'top':
        return {
            x: work.x,
            y: work.y,
            width: work.width,
            height: Math.round(work.height * p),
        };
    case 'bottom': {
        const height = Math.round(work.height * p);
        return {
            x: work.x,
            y: work.y + work.height - height,
            width: work.width,
            height,
        };
    }
    case 'left':
        return {
            x: work.x,
            y: work.y,
            width: Math.round(work.width * p),
            height: work.height,
        };
    case 'right': {
        const width = Math.round(work.width * p);
        return {
            x: work.x + work.width - width,
            y: work.y,
            width,
            height: work.height,
        };
    }
    }
}

export function percentFromRect(
    side: QuakeSide,
    rect: Rect,
    monitorIndex: number,
): number {
    const work = getWorkAreaForMonitor(monitorIndex);
    let ratio: number;
    if (side === 'top' || side === 'bottom')
        ratio = work.height > 0 ? rect.height / work.height : 0.4;
    else
        ratio = work.width > 0 ? rect.width / work.width : 0.4;

    return Math.min(90, Math.max(10, Math.round(ratio * 100)));
}

export function slideOffsetForSide(side: QuakeSide, rect: Rect): { x: number; y: number } {
    switch (side) {
    case 'top':
        return { x: 0, y: -rect.height };
    case 'bottom':
        return { x: 0, y: rect.height };
    case 'left':
        return { x: -rect.width, y: 0 };
    case 'right':
        return { x: rect.width, y: 0 };
    }
}
