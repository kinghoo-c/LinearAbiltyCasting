import { App } from './core/App.js';
import { LoadingScreen } from './ui/HUD.js';

/**
 * 入口点。
 *
 * 所有有意思的东西都在 `core/App.js` 里；本文件只负责把应用接到页面上，
 * 并把致命的启动错误报告到用户看得见的地方。
 */
const canvas = document.getElementById('viewport');

async function boot() {
    try {
        const app = new App(canvas);
        await app.load();

        // 方便在控制台里摆弄场景。
        window.app = app;
    } catch (error) {
        console.error('[boot] failed to start', error);
        new LoadingScreen().fail(
            error?.message ? `Failed to start: ${error.message}` : 'Failed to start — see the console.'
        );
    }
}

boot();
