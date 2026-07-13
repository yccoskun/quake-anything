import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

/**
 * Best-effort conflict scan of system keyboard shortcut schemas.
 * Prefs cannot use Meta/Shell; this only covers known GSettings keybindings.
 */
export function findShortcutConflict(
    accelerator: string,
    excludeOurShortcuts: string[] = [],
): string | null {
    if (!accelerator)
        return null;

    const normalized = normalizeAccel(accelerator);
    if (!normalized)
        return null;

    for (const ours of excludeOurShortcuts) {
        if (normalizeAccel(ours) === normalized)
            return 'another Quake Anything entry';
    }

    const schemaSources = [
        'org.gnome.desktop.wm.keybindings',
        'org.gnome.shell.keybindings',
        'org.gnome.mutter.keybindings',
        'org.gnome.mutter.wayland.keybindings',
        'org.gnome.settings-daemon.plugins.media-keys',
    ];

    for (const schemaId of schemaSources) {
        const conflict = scanSchema(schemaId, normalized);
        if (conflict)
            return conflict;
    }

    const custom = scanCustomMediaKeys(normalized);
    if (custom)
        return custom;

    return null;
}

function scanSchema(schemaId: string, normalized: string): string | null {
    let settings: Gio.Settings;
    try {
        settings = new Gio.Settings({ schema_id: schemaId });
    } catch {
        return null;
    }

    for (const key of settings.list_keys()) {
        try {
            const value = settings.get_value(key);
            if (!value)
                continue;
            if (value.get_type_string() === 'as') {
                const bindings = value.get_strv();
                for (const b of bindings) {
                    if (normalizeAccel(b) === normalized)
                        return `${schemaId}.${key}`;
                }
            } else if (value.get_type_string() === 's') {
                const b = value.get_string()[0];
                if (normalizeAccel(b) === normalized)
                    return `${schemaId}.${key}`;
            }
        } catch {
            // skip non-compatible keys
        }
    }
    return null;
}

function scanCustomMediaKeys(normalized: string): string | null {
    let settings: Gio.Settings;
    try {
        settings = new Gio.Settings({
            schema_id: 'org.gnome.settings-daemon.plugins.media-keys',
        });
    } catch {
        return null;
    }

    let paths: string[] = [];
    try {
        paths = settings.get_strv('custom-keybindings');
    } catch {
        return null;
    }

    for (const path of paths) {
        try {
            const custom = Gio.Settings.new_with_path(
                'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding',
                path,
            );
            const binding = custom.get_string('binding');
            const name = custom.get_string('name') || path;
            if (normalizeAccel(binding) === normalized)
                return `custom:${name}`;
        } catch {
            // ignore
        }
    }
    return null;
}

export function normalizeAccel(accel: string): string {
    if (!accel)
        return '';
    try {
        const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
        if (!ok || keyval === 0 || mods == null)
            return accel.toLowerCase();
        return Gtk.accelerator_name(keyval, mods)?.toLowerCase() ?? accel.toLowerCase();
    } catch {
        return accel.toLowerCase();
    }
}

export function acceleratorIsValid(accel: string): boolean {
    if (!accel)
        return false;
    try {
        const [ok, keyval, mods] = Gtk.accelerator_parse(accel);
        if (!ok || keyval === 0 || mods == null)
            return false;
        return Gtk.accelerator_valid(keyval, mods);
    } catch {
        return false;
    }
}
