import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { ShortcutDialog } from './prefs/shortcut-dialog.js';
import {
    createEntryId,
    entriesToTuples,
    isQuakeSide,
    parseEntries,
    type QuakeEntry,
    type QuakeEntryTuple,
    type QuakeSide,
} from './types.js';

const SIDE_LABELS: { id: QuakeSide; title: string; subtitle: string }[] = [
    { id: 'top', title: 'Top', subtitle: 'Docked to top, expands downward' },
    { id: 'bottom', title: 'Bottom', subtitle: 'Docked to bottom, expands upward' },
    { id: 'left', title: 'Left', subtitle: 'Docked to left, expands rightward' },
    { id: 'right', title: 'Right', subtitle: 'Docked to right, expands leftward' },
];

export default class QuakeAnythingPreferences extends ExtensionPreferences {
    private _listGroup: Adw.PreferencesGroup | null = null;
    private _window: Adw.PreferencesWindow | null = null;
    private _settings: Gio.Settings | null = null;
    private _rows: Gtk.Widget[] = [];

    async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        (window as Adw.PreferencesWindow & { _settings?: Gio.Settings })._settings = settings;
        this._window = window;
        this._settings = settings;

        window.search_enabled = true;
        window.default_width = 640;
        window.default_height = 560;

        const page = new Adw.PreferencesPage({
            title: _('Applications'),
            icon_name: 'preferences-desktop-apps-symbolic',
        });
        window.add(page);

        this._listGroup = new Adw.PreferencesGroup({
            title: _('Quake applications'),
            description: _('Each entry docks an app to a screen edge and toggles it with a shortcut.'),
        });
        page.add(this._listGroup);

        this._rebuildList();
        settings.connect('changed::entries', () => this._rebuildList());
    }

    private _rebuildList(): void {
        const group = this._listGroup;
        const window = this._window;
        const settings = this._settings;
        if (!group || !window || !settings)
            return;

        // PreferencesGroup rows are not flat GTK children — remove by reference.
        for (const row of this._rows)
            group.remove(row);
        this._rows = [];

        for (const entry of this._loadEntries(settings)) {
            const row = this._createEntryRow(window, settings, entry);
            group.add(row);
            this._rows.push(row);
        }

        const addRow = new Adw.ActionRow({
            activatable: true,
            title: _('Add Application'),
        });
        addRow.add_prefix(new Gtk.Image({ icon_name: 'list-add-symbolic' }));
        addRow.connect('activated', () => {
            this._openEditor(window, settings, null);
        });
        group.add(addRow);
        this._rows.push(addRow);
    }

    private _createEntryRow(
        window: Adw.PreferencesWindow,
        settings: Gio.Settings,
        entry: QuakeEntry,
    ): Adw.ActionRow {
        const appInfo = GioUnix.DesktopAppInfo.new(entry.appId)
            ?? GioUnix.DesktopAppInfo.new(`${entry.appId}.desktop`);
        const title = appInfo?.get_display_name() ?? entry.appId;
        const sideInfo = SIDE_LABELS.find(s => s.id === entry.side);
        const shortcut = entry.shortcut
            ? entry.shortcut.replace(/</g, '').replace(/>/g, '+')
            : _('Disabled');

        const row = new Adw.ActionRow({
            title,
            subtitle: `${sideInfo?.title ?? entry.side} · ${entry.sizePercent}% · ${shortcut}`,
            activatable: true,
        });

        if (appInfo) {
            const gicon = appInfo.get_icon();
            if (gicon) {
                row.add_prefix(new Gtk.Image({
                    gicon,
                    pixel_size: 32,
                }));
            }
        }

        const editBtn = new Gtk.Button({
            icon_name: 'document-edit-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
        });
        editBtn.connect('clicked', () => {
            this._openEditor(window, settings, entry);
        });
        row.add_suffix(editBtn);

        const removeBtn = new Gtk.Button({
            icon_name: 'user-trash-symbolic',
            valign: Gtk.Align.CENTER,
            has_frame: false,
        });
        removeBtn.add_css_class('destructive-action');
        removeBtn.connect('clicked', () => {
            const entries = this._loadEntries(settings).filter(e => e.id !== entry.id);
            this._saveEntries(settings, entries);
        });
        row.add_suffix(removeBtn);

        row.connect('activated', () => {
            this._openEditor(window, settings, entry);
        });

        return row;
    }

    private _openEditor(
        window: Adw.PreferencesWindow,
        settings: Gio.Settings,
        existing: QuakeEntry | null,
    ): void {
        const dialog = new Adw.Dialog({
            title: existing ? _('Edit Application') : _('Add Application'),
            content_width: 480,
        });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        toolbar.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup();
        page.add(group);

        let appId = existing?.appId ?? '';
        let side: QuakeSide = existing?.side ?? 'top';
        let shortcut = existing?.shortcut ?? '';
        let sizePercent = existing?.sizePercent ?? 40;

        const appRow = new Adw.ActionRow({
            title: _('Application'),
            subtitle: this._appDisplayName(appId) || _('Choose an application…'),
            activatable: true,
        });
        const appIcon = new Gtk.Image({
            icon_name: 'application-x-executable-symbolic',
            pixel_size: 32,
        });
        appRow.add_prefix(appIcon);
        this._updateAppIcon(appIcon, appId);

        appRow.connect('activated', () => {
            this._pickApp(window, (info) => {
                const id = info.get_id();
                if (!id)
                    return;
                appId = id;
                appRow.subtitle = info.get_display_name() || id;
                this._updateAppIcon(appIcon, id);
            });
        });
        group.add(appRow);

        const sideModel = Gtk.StringList.new(SIDE_LABELS.map(s => s.title));
        const sideRow = new Adw.ComboRow({
            title: _('Side'),
            subtitle: SIDE_LABELS.find(s => s.id === side)?.subtitle ?? '',
            model: sideModel,
            selected: Math.max(0, SIDE_LABELS.findIndex(s => s.id === side)),
        });
        sideRow.connect('notify::selected', () => {
            const idx = sideRow.selected;
            if (idx >= 0 && idx < SIDE_LABELS.length) {
                side = SIDE_LABELS[idx].id;
                sideRow.subtitle = SIDE_LABELS[idx].subtitle;
            }
        });
        group.add(sideRow);

        const shortcutRow = new Adw.ActionRow({
            title: _('Keyboard shortcut'),
            subtitle: shortcut || _('Disabled'),
            activatable: true,
        });
        const shortcutLabel = new Gtk.ShortcutLabel({
            accelerator: shortcut || '',
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        shortcutRow.add_suffix(shortcutLabel);
        shortcutRow.connect('activated', async () => {
            const others = this._loadEntries(settings)
                .filter(e => e.id !== existing?.id && e.shortcut)
                .map(e => e.shortcut);
            const capture = new ShortcutDialog(
                window,
                this._appDisplayName(appId) || _('Application'),
                others,
            );
            const result = await capture.present();
            if (result.accelerator === null)
                return;
            shortcut = result.accelerator;
            shortcutLabel.accelerator = shortcut;
            shortcutRow.subtitle = shortcut || _('Disabled');
            if (result.conflict) {
                window.add_toast(new Adw.Toast({
                    title: _('Warning: shortcut may conflict with %s').replace('%s', result.conflict),
                    timeout: 5,
                }));
            }
        });
        group.add(shortcutRow);

        const sizeRow = new Adw.SpinRow({
            title: _('Default size'),
            subtitle: _('Percentage of the monitor work area'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 90,
                step_increment: 1,
                page_increment: 5,
                value: sizePercent,
            }),
        });
        sizeRow.connect('notify::value', () => {
            sizePercent = Math.round(sizeRow.value);
        });
        group.add(sizeRow);

        toolbar.set_content(page);
        dialog.set_child(toolbar);

        const cancelBtn = new Gtk.Button({ label: _('Cancel') });
        cancelBtn.connect('clicked', () => dialog.close());
        header.pack_start(cancelBtn);

        const saveBtn = new Gtk.Button({ label: _('Save') });
        saveBtn.add_css_class('suggested-action');
        saveBtn.connect('clicked', () => {
            if (!appId) {
                window.add_toast(new Adw.Toast({ title: _('Please choose an application') }));
                return;
            }
            if (!isQuakeSide(side)) {
                window.add_toast(new Adw.Toast({ title: _('Please choose a side') }));
                return;
            }

            const entries = this._loadEntries(settings);
            const next: QuakeEntry = {
                id: existing?.id ?? createEntryId(),
                appId,
                side,
                shortcut,
                sizePercent: Math.min(90, Math.max(10, sizePercent)),
            };

            const idx = entries.findIndex(e => e.id === next.id);
            if (idx >= 0)
                entries[idx] = next;
            else
                entries.push(next);

            this._saveEntries(settings, entries);
            dialog.close();
        });
        header.pack_end(saveBtn);

        dialog.present(window);
    }

    private _pickApp(
        parent: Gtk.Window,
        onPicked: (info: Gio.AppInfo) => void,
    ): void {
        const dialog = new Adw.Dialog({
            title: _('Choose Application'),
            content_width: 420,
            content_height: 520,
        });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        toolbar.add_top_bar(header);

        const search = new Gtk.SearchEntry({
            placeholder_text: _('Search applications…'),
            margin_start: 12,
            margin_end: 12,
            margin_top: 6,
            margin_bottom: 6,
        });

        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            hexpand: true,
            vexpand: true,
        });
        list.add_css_class('navigation-sidebar');

        const apps = Gio.AppInfo.get_all()
            .filter(a => a.should_show() && !!a.get_id())
            .sort((a, b) =>
                (a.get_display_name() ?? '').localeCompare(b.get_display_name() ?? ''));

        const rows: { row: Gtk.ListBoxRow; name: string; id: string }[] = [];
        for (const app of apps) {
            const id = app.get_id()!;
            const name = app.get_display_name() ?? id;
            const row = new Gtk.ListBoxRow();
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 12,
                margin_start: 8,
                margin_end: 8,
                margin_top: 6,
                margin_bottom: 6,
            });
            const image = new Gtk.Image({ pixel_size: 32 });
            const gicon = app.get_icon();
            if (gicon)
                image.gicon = gicon;
            else
                image.icon_name = 'application-x-executable-symbolic';
            box.append(image);
            box.append(new Gtk.Label({
                label: name,
                xalign: 0,
                hexpand: true,
            }));
            row.set_child(box);
            list.append(row);
            rows.push({ row, name: name.toLowerCase(), id });
        }

        search.connect('search-changed', () => {
            const q = search.text.trim().toLowerCase();
            for (const item of rows)
                item.row.visible = !q || item.name.includes(q) || item.id.toLowerCase().includes(q);
        });

        list.connect('row-activated', (_l, row) => {
            const match = rows.find(r => r.row === row);
            if (!match)
                return;
            const info = GioUnix.DesktopAppInfo.new(match.id);
            if (info)
                onPicked(info);
            dialog.close();
        });

        const scroll = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true,
            child: list,
        });

        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
        box.append(search);
        box.append(scroll);
        toolbar.set_content(box);
        dialog.set_child(toolbar);

        const cancel = new Gtk.Button({ label: _('Cancel') });
        cancel.connect('clicked', () => dialog.close());
        header.pack_start(cancel);

        dialog.present(parent);
    }

    private _appDisplayName(appId: string): string {
        if (!appId)
            return '';
        const info = GioUnix.DesktopAppInfo.new(appId)
            ?? GioUnix.DesktopAppInfo.new(`${appId}.desktop`);
        return info?.get_display_name() ?? appId;
    }

    private _updateAppIcon(image: Gtk.Image, appId: string): void {
        if (!appId) {
            image.icon_name = 'application-x-executable-symbolic';
            return;
        }
        const info = GioUnix.DesktopAppInfo.new(appId)
            ?? GioUnix.DesktopAppInfo.new(`${appId}.desktop`);
        const gicon = info?.get_icon();
        if (gicon)
            image.gicon = gicon;
        else
            image.icon_name = 'application-x-executable-symbolic';
    }

    private _loadEntries(settings: Gio.Settings): QuakeEntry[] {
        const raw = settings.get_value('entries').deep_unpack() as QuakeEntryTuple[];
        return parseEntries(raw);
    }

    private _saveEntries(settings: Gio.Settings, entries: QuakeEntry[]): void {
        const tuples = entriesToTuples(entries);
        settings.set_value('entries', new GLib.Variant('a(ssssi)', tuples));
    }
}
