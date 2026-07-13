import '@girs/gnome-shell/ambient';
import '@girs/gnome-shell/extensions/global';

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

export default class TypeScriptExtension extends Extension {
    // Correctly type the indicator as PanelMenu.Button
    private _indicator: PanelMenu.Button | null = null;

    enable() {
        // 1. Initialize the official PanelMenu Button
        // Arguments: (menuAlign: number, nameText: string, dontCreateMenu?: boolean)
        this._indicator = new PanelMenu.Button(0.5, this.metadata.name, false);

        // 2. Create the child element you want inside the button
        const label = new St.Label({
            text: 'TS Active',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ts-indicator-label'
        });

        // 3. Add your label inside the PanelMenu.Button wrapper
        this._indicator.add_child(label);

        // 4. Add the PanelMenu.Button to the panel status area
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        console.log(`[${this.uuid}] Extension enabled via TS bundle!`);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        console.log(`[${this.uuid}] Extension disabled.`);
    }
}
