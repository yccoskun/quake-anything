import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export type KeybindingHandler = () => void;

interface Grabber {
    action: number;
    name: string;
    accelerator: string;
    handler: KeybindingHandler;
}

/**
 * Dynamic accelerator grabs for an unbounded number of shortcuts.
 * Uses Meta.Display.grab_accelerator instead of schema-backed addKeybinding.
 */
export class KeybindingManager {
    private _grabbers = new Map<number, Grabber>();
    private _byId = new Map<string, number>();
    private _activatedId = 0;

    enable(): void {
        this._activatedId = global.display.connect(
            'accelerator-activated',
            (_display, action) => {
                const grabber = this._grabbers.get(action);
                if (grabber)
                    grabber.handler();
            },
        );
    }

    disable(): void {
        if (this._activatedId) {
            global.display.disconnect(this._activatedId);
            this._activatedId = 0;
        }
        for (const id of [...this._byId.keys()])
            this.unbind(id);
    }

    /**
     * Bind or rebind a shortcut for a logical id.
     * @returns false if the accelerator could not be grabbed (conflict / invalid)
     */
    bind(id: string, accelerator: string, handler: KeybindingHandler): boolean {
        this.unbind(id);

        if (!accelerator)
            return true;

        const action = global.display.grab_accelerator(
            accelerator,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
        );

        if (action === Meta.KeyBindingAction.NONE)
            return false;

        const name = Meta.external_binding_name_for_action(action);
        Main.wm.allowKeybinding(
            name,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
        );

        this._grabbers.set(action, { action, name, accelerator, handler });
        this._byId.set(id, action);
        return true;
    }

    unbind(id: string): void {
        const action = this._byId.get(id);
        if (action == null)
            return;

        const grabber = this._grabbers.get(action);
        global.display.ungrab_accelerator(action);
        if (grabber)
            Main.wm.allowKeybinding(grabber.name, Shell.ActionMode.NONE);

        this._grabbers.delete(action);
        this._byId.delete(id);
    }
}
