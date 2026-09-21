import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    server: {
        host: '127.0.0.1',
        port: 5173,
        open: false,
    },
    build: {
        target: 'es2022',
        sourcemap: true,
        chunkSizeWarningLimit: 2000,
    },
    // 大型二进制资源（FBX / HDR）放在 /public 中，按原样提供。
    assetsInclude: ['**/*.fbx', '**/*.hdr'],
});
