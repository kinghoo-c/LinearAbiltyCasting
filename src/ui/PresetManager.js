import { settings, applySettings, snapshotSettings, DEFAULT_SETTINGS } from '../config/settings.js';

// 重新做了命名空间：设置树是围绕冰霜技能重建的，所以针对旧元素
// 区块保存的预设合并进来会什么都不剩。
const STORAGE_KEY = 'frost-sandbox.presets.v1';
const LAST_KEY = 'frost-sandbox.lastPreset';

/**
 * 预设持久化。
 *
 * 预设就是设置树的纯快照，存储在 localStorage 中，也可导出为 JSON。
 * 加载时是*合并进*实时设置对象而不是替换它们，因此着色器或粒子系统
 * 持有的每一个绑定都保持有效——这正是预设能在施放中途切换的原因。
 */
export class PresetManager {
    constructor() {
        this.presets = this._read();
    }

    _read() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (error) {
            console.warn('[PresetManager] could not read presets', error);
            return {};
        }
    }

    _write() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.presets));
        } catch (error) {
            console.warn('[PresetManager] could not persist presets', error);
        }
    }

    get names() {
        return Object.keys(this.presets).sort();
    }

    has(name) {
        return Object.prototype.hasOwnProperty.call(this.presets, name);
    }

    save(name) {
        if (!name) return false;
        this.presets[name] = snapshotSettings();
        this._write();
        localStorage.setItem(LAST_KEY, name);
        return true;
    }

    load(name) {
        const preset = this.presets[name];
        if (!preset) return false;
        applySettings(preset);
        localStorage.setItem(LAST_KEY, name);
        return true;
    }

    duplicate(name) {
        if (!this.has(name)) return null;
        let copy = `${name} copy`;
        let index = 2;
        while (this.has(copy)) copy = `${name} copy ${index++}`;
        this.presets[copy] = structuredClone(this.presets[name]);
        this._write();
        return copy;
    }

    remove(name) {
        if (!this.has(name)) return false;
        delete this.presets[name];
        this._write();
        return true;
    }

    reset() {
        applySettings(structuredClone(DEFAULT_SETTINGS));
    }

    /** 触发下载当前设置（或某个命名预设）。 */
    exportJSON(name = null) {
        const data = name && this.has(name) ? this.presets[name] : snapshotSettings();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${(name ?? 'frost-settings').replace(/\s+/g, '-').toLowerCase()}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    /** 把所有已保存的预设导出到一个文件。 */
    exportAll() {
        const blob = new Blob([JSON.stringify(this.presets, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'frost-presets.json';
        anchor.click();
        URL.revokeObjectURL(url);
    }

    /**
     * 从用户选择的 JSON 文件导入。
     * 既接受单个设置快照，也接受一份预设映射表。
     * @returns {Promise<{ imported: string[], applied: boolean }>}
     */
    importFromFile() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json,.json';
            input.onchange = async () => {
                const file = input.files?.[0];
                if (!file) return resolve({ imported: [], applied: false });
                try {
                    const data = JSON.parse(await file.text());
                    // 设置快照永远带有 `global` 区块；其他形状一律
                    // 当作预设集合处理。
                    if (data && data.global && data.ice) {
                        applySettings(data);
                        resolve({ imported: [], applied: true });
                    } else {
                        const names = [];
                        for (const [name, preset] of Object.entries(data)) {
                            if (preset && typeof preset === 'object') {
                                this.presets[name] = preset;
                                names.push(name);
                            }
                        }
                        this._write();
                        resolve({ imported: names, applied: false });
                    }
                } catch (error) {
                    console.error('[PresetManager] import failed', error);
                    resolve({ imported: [], applied: false });
                }
            };
            input.click();
        });
    }

    /** 当前实时设置，供想要检视它们的调用方使用。 */
    get current() {
        return settings;
    }
}
