import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import { acceleratorIsValid, findShortcutConflict } from './conflicts.js';

export interface ShortcutDialogResult {
    accelerator: string | null; // null = cancelled, '' = disabled
    conflict: string | null;
}

/**
 * GNOME Settings–style “Set Shortcut” capture dialog.
 * Esc cancels, Backspace disables, other keys set the accelerator.
 */
export class ShortcutDialog {
    private _window: Adw.Window;
    private _resolve: ((result: ShortcutDialogResult) => void) | null = null;
    private _otherShortcuts: string[];
    private _status: Gtk.Label;
    private _warn: Gtk.Label;

    constructor(parent: Gtk.Window, actionLabel: string, otherShortcuts: string[] = []) {
        this._otherShortcuts = otherShortcuts;

        this._window = new Adw.Window({
            title: 'Set Shortcut',
            modal: true,
            transient_for: parent,
            default_width: 500,
            default_height: 360,
            resizable: false,
        });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar({
            show_end_title_buttons: true,
            show_start_title_buttons: false,
        });
        toolbar.add_top_bar(header);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
        });

        const instruction = new Gtk.Label({
            label: `Enter new shortcut to change <b>${escapeMarkup(actionLabel)}</b>`,
            use_markup: true,
            wrap: true,
            justify: Gtk.Justification.CENTER,
        });
        box.append(instruction);

        // Minimal keyboard hint graphic (CSS-drawn keys)
        const keysRow = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.CENTER,
            margin_top: 12,
            margin_bottom: 12,
        });
        for (let i = 0; i < 3; i++) {
            const key = new Gtk.Frame({
                width_request: 48,
                height_request: 40,
            });
            key.add_css_class('card');
            const arrow = new Gtk.Image({
                icon_name: 'go-down-symbolic',
                pixel_size: 16,
                halign: Gtk.Align.CENTER,
                valign: Gtk.Align.CENTER,
            });
            key.set_child(arrow);
            keysRow.append(key);
        }
        box.append(keysRow);

        this._status = new Gtk.Label({
            label: 'Press a key combination…',
            wrap: true,
            justify: Gtk.Justification.CENTER,
        });
        this._status.add_css_class('title-2');
        box.append(this._status);

        this._warn = new Gtk.Label({
            label: '',
            wrap: true,
            justify: Gtk.Justification.CENTER,
            visible: false,
        });
        this._warn.add_css_class('warning');
        this._warn.add_css_class('dim-label');
        box.append(this._warn);

        const footer = new Gtk.Label({
            label: 'Press Esc to cancel or Backspace to disable the keyboard shortcut',
            wrap: true,
            justify: Gtk.Justification.CENTER,
        });
        footer.add_css_class('dim-label');
        box.append(footer);

        toolbar.set_content(box);
        this._window.set_content(toolbar);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            return this._onKeyPressed(keyval, keycode, state);
        });
        this._window.add_controller(controller);

        this._window.connect('close-request', () => {
            this._finish({ accelerator: null, conflict: null });
            return false;
        });
    }

    present(): Promise<ShortcutDialogResult> {
        return new Promise(resolve => {
            this._resolve = resolve;
            this._window.present();
        });
    }

    private _onKeyPressed(keyval: number, keycode: number, state: Gdk.ModifierType): boolean {
        if (keyval === Gdk.KEY_Escape) {
            this._finish({ accelerator: null, conflict: null });
            return true;
        }

        if (keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) {
            this._finish({ accelerator: '', conflict: null });
            return true;
        }

        // Ignore lone modifiers
        if (
            keyval === Gdk.KEY_Control_L || keyval === Gdk.KEY_Control_R
            || keyval === Gdk.KEY_Shift_L || keyval === Gdk.KEY_Shift_R
            || keyval === Gdk.KEY_Alt_L || keyval === Gdk.KEY_Alt_R
            || keyval === Gdk.KEY_Meta_L || keyval === Gdk.KEY_Meta_R
            || keyval === Gdk.KEY_Super_L || keyval === Gdk.KEY_Super_R
            || keyval === Gdk.KEY_Hyper_L || keyval === Gdk.KEY_Hyper_R
            || keyval === Gdk.KEY_ISO_Level3_Shift
        )
            return true;

        const mods = state & Gtk.accelerator_get_default_mod_mask();
        const display = this._window.get_display();
        let accel = '';
        try {
            accel = Gtk.accelerator_name_with_keycode(display, keyval, keycode, mods) ?? '';
        } catch {
            accel = Gtk.accelerator_name(keyval, mods) ?? '';
        }

        if (!accel || !acceleratorIsValid(accel)) {
            this._status.label = 'Invalid shortcut';
            return true;
        }

        const conflict = findShortcutConflict(accel, this._otherShortcuts);
        this._status.label = accel.replace(/</g, '').replace(/>/g, '+');
        if (conflict) {
            this._warn.label = `Warning: this shortcut is already used by ${conflict}. It may not work.`;
            this._warn.visible = true;
        } else {
            this._warn.visible = false;
        }

        this._finish({
            accelerator: accel,
            conflict,
        });
        return true;
    }

    private _finish(result: ShortcutDialogResult): void {
        const resolve = this._resolve;
        this._resolve = null;
        this._window.destroy();
        resolve?.(result);
    }
}

function escapeMarkup(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
