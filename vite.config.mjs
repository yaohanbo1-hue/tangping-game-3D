// 3D 工程的 Vite 配置。
//
// 三个要点：
//  1. base: './' —— 产物可以用 file:// 或任意子路径打开，也能直接部署到
//     GitHub Pages 的 /<repo>/ 子路径下（相对路径不需要知道仓库名）。
//  2. resolve.dedupe: ['three'] —— 将来若引入 three 生态的 addons，避免多份 three 实例。
//  3. optimizeDeps.exclude: ['@tangping/story'] —— 叙事包是本地 file: 依赖的源码，
//     不需要预打包；排除掉可以让「改叙事源文件 → 立即热更」生效。
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5273,
    strictPort: false,
    open: false,
  },
  preview: {
    port: 5274,
  },
  resolve: {
    dedupe: ['three'],
  },
  optimizeDeps: {
    exclude: ['@tangping/story'],
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
    rollupOptions: {
      output: {
        // 分包策略：
        //   · three 单独一块（683KB，几乎不变，缓存价值最高）
        //   · 叙事包单独一块（改动频率与引擎不同，独立缓存更划算）
        //
        // ⚠️ 叙事包的 id 不能用 '@tangping/story' 精确匹配 —— Rollup 看到的是
        //    **解析后的真实路径**，而这个路径取决于包是怎么装进来的：
        //
        //      · `npm ci`（CI / 正常安装）→ npm 建软链，Rollup 默认解析软链，
        //        看到的是 <repo>/packages/story/xxx.js
        //      · 手工把包**复制**进 node_modules → 看到的是
        //        <repo>/node_modules/@tangping/story/xxx.js
        //
        //    两种都要覆盖，否则规则会**静默失效**：分块不会报错，只是叙事包
        //    被悄悄并进 index，体积与缓存策略都变了而构建日志里看不出来。
        //    （这条规则刚搬到本仓库时就踩过一次 —— 匹配 '/src/story/' 不再命中。）
        manualChunks(id) {
          const norm = id.replace(/\\/g, '/');
          if (norm.includes('/packages/story/') || norm.includes('/@tangping/story/')) return 'story';
          if (norm.includes('node_modules/three')) return 'three';
        },
      },
    },
  },
});
