export type QuakeSide = 'top' | 'bottom' | 'left' | 'right';

export interface QuakeEntry {
    id: string;
    appId: string;
    side: QuakeSide;
    shortcut: string;
    sizePercent: number;
}

/** GVariant unpack shape for entries key: a(ssssi) */
export type QuakeEntryTuple = [string, string, string, string, number];

export function isQuakeSide(value: string): value is QuakeSide {
    return value === 'top' || value === 'bottom' || value === 'left' || value === 'right';
}

export function parseEntries(raw: QuakeEntryTuple[]): QuakeEntry[] {
    const entries: QuakeEntry[] = [];
    for (const tuple of raw) {
        if (!Array.isArray(tuple) || tuple.length < 5)
            continue;
        const [id, appId, side, shortcut, sizePercent] = tuple;
        if (!id || !appId || !isQuakeSide(side))
            continue;
        const percent = Math.round(Number(sizePercent));
        entries.push({
            id,
            appId,
            side,
            shortcut: shortcut ?? '',
            sizePercent: Math.min(90, Math.max(10, Number.isFinite(percent) ? percent : 40)),
        });
    }
    return entries;
}

export function entriesToTuples(entries: QuakeEntry[]): QuakeEntryTuple[] {
    return entries.map(e => [
        e.id,
        e.appId,
        e.side,
        e.shortcut,
        e.sizePercent,
    ]);
}

export function createEntryId(): string {
    return `entry-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}
