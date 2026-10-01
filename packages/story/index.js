// ============================================================
//  @tangping/story —— 叙事层统一入口
// ============================================================
//
// 这一层是「3D 迁移中最值钱的资产」：对渲染层零耦合，
// 2D 版和 3D 版共用同一份数据源与同一套运行时。
//
// ── 分层（务必遵守）──────────────────────────────────────
//
//   ┌── 数据层（纯数据，零依赖）─────────────────────────┐
//   │  story.js        剧情总源：幕结构 / 角色表 / 主线波次 / BOSS 对话 │
//   │  lore.js         世界观设定集：词条 / 梦境法则 / 分类        │
//   │  sidestories.js  支线剧情                              │
//   │  events.js       关键事件与幕间转折                      │
//   │  perspectives.js 视角插叙                              │
//   │  bosslore.js     BOSS 阶段台词池与深度档案                │
//   │  chapters.js     章节数据（五幕骨架 + 子章节）             │
//   └──────────────────────────────────────────────────┘
//   ┌── 运行时层（有状态，依赖注入）──────────────────────┐
//   │  host.js         宿主接口（弹对白/提示/奖励/日记）        │
//   │  pacing.js       波次剧情预算                          │
//   │  runtime-ctx.js  共享单例注册点（防循环依赖）             │
//   │  runtime.js      波次管线总装（★ 宿主唯一需要调的入口）    │
//   └──────────────────────────────────────────────────┘
//
// ── 为什么运行时也在包里 ─────────────────────────────────
//
//   原本运行时（SideStorySystem 等）留在 2D 引擎里，靠全局作用域
//   用 `typeof` 判空互相引用。3D 版没有那个全局作用域，
//   如果照搬就得往 window 上挂假全局 —— 那是把 2D 的架构债搬到 3D。
//
//   所以把这些运行时也收进包里，并引入**宿主注入**：
//   运行时只认 host 接口，谁来提供由宿主决定。
//   这样两个宿主跑的是**同一份实现**，「节奏不一致」这个 bug 从根上消失。
//
// ── 宿主需要做什么 ───────────────────────────────────────
//
//   3D 侧：
//     import { createStoryRuntime } from '@tangping/story';
//     const story = createStoryRuntime({ host: myHost });
//     story.onWaveStart(wave);
//
//   2D 侧：
//     不改。它继续用引擎里的全局版本（行为不变），
//     本包新增的 runtime.js 同时充当两者行为的「规格说明」。
//
// ⚠️ 本包不得 import 引擎层任何东西，不得出现 document / window / canvas。
//    （host.js 里有 `globalThis`，那是**兼容层**，只为 2D 回落使用。）
// ============================================================

// ── 数据层 ──
export * from './story.js';
export * from './lore.js';
export * from './sidestories.js';
export * from './events.js';
export * from './perspectives.js';
export * from './bosslore.js';
export * from './chapters.js';

// ── 运行时层 ──
export {
  setStoryHost, getStoryHost, hasInjectedHost, auditHost,
} from './host.js';
export { StoryPacing, createStoryPacing, hasMainStory, isTurningWave } from './pacing.js';
export {
  getPacing, setPacing, getLoreCodex, getAffinitySystem,
  registerLoreCodex, registerAffinitySystem,
  unlockLoreById, runtimeRefs, resetRuntimeCtx,
} from './runtime-ctx.js';
export {
  createStoryRuntime, PIPELINE, PIPELINE_ORDER,
} from './runtime.js';
