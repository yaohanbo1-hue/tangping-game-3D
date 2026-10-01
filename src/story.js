// ============================================================
//  story.js —— 叙事包适配层（3D 侧唯一允许 import @tangping/story 的地方）
// ============================================================
//
// 这是第 3 步里最有战略意义的一小块：验证 3D 工程能**直接 import**
// 第 2 步抽出来的 @tangping/story 包。
//
// 为什么不让 3D 代码到处直接 `import { STORY_ARCS } from '@tangping/story'`：
//   · 3D 版对叙事数据的**使用形态**和 2D 版不同（2D 读全局变量，
//     3D 要自己组织章节推进），中间加一层适配能把差异关在这里；
//   · 将来叙事包换代（比如改成 JSON 资源或远程加载）只改这一个文件；
//   · 这一层是**唯一**允许 import 叙事包的地方，
//     可以用 verify-imports.mjs 静态检查，防止架构腐化。
//
// ── 第 5 步的扩展：这里同时也是**叙事运行时**的出口 ──────────
//
// 第 5 步之前，叙事运行时（章节推进/支线/事件/插叙）留在 2D 引擎里，
// 靠 `typeof xxx !== 'undefined'` 在全局作用域里互相找。3D 版没有那个
// 全局作用域，所以运行时被收进了叙事包，并改成**宿主注入**（见包内
// host.js 的 StoryHost 契约）。
//
// 于是本文件的角色变成「叙事包在 3D 侧的唯一门」：
//   · 导出数据（STORY_ARCS / WAVE_STORY / LORE_ENTRIES …）
//   · 导出运行时工厂（createStoryRuntime）与宿主注入点（setStoryHost）
//   · 导出规模自检（loadStoryManifest）
//
// ⚠️ 为什么仍然坚持「只此一处 import 叙事包」而不是允许各文件自取：
//    叙事包将来可能整体换成远程 JSON / 分包懒加载 / 另一套方言。
//    只要收口在这一个文件，那天要改的就只有这里。
//    verify-imports.mjs 的边界2 就是在守这条线。
//
//    （新增 src/story-runtime.js 时曾被漏掉 —— 它 import 了叙事包但
//     不在白名单里，verify:imports 立刻报红。这就是这条边界的价值：
//     它把「架构腐化」变成了一个会失败的测试，而不是代码评审里的意见。）
// ============================================================

import {
  STORY_ARCS,
  STORY_CHARACTERS,
  WAVE_STORY,
  BOSS_DIALOG,
  LORE_ENTRIES,
  KEY_EVENTS,
  SIDE_STORIES,
  PERSPECTIVE_SCENES,
  BOSS_PROFILES,
  SOUND_MELODIES,
  STORY_VIDEO_SLOTS,
  // ── 运行时层（第 5 步）──
  createStoryRuntime,
  PIPELINE,
  PIPELINE_ORDER,
  setStoryHost,
  getStoryHost,
  hasInjectedHost,
  auditHost,
  createStoryPacing,
  StoryPacing,
  getPacing,
  setPacing,
  getLoreCodex,
  getAffinitySystem,
  registerLoreCodex,
  registerAffinitySystem,
  unlockLoreById,
  runtimeRefs,
  resetRuntimeCtx,
  // ── 章节数据（日记面板要用）──
  CHAPTER_DEFS,
  CHAPTER_ACTS,
  ChapterSystem,
  // ── 各系统的进度/快照接口（结局判定与存档要用）──
  LoreCodex,
  SideStorySystem,
  KeyEventSystem,
  PerspectiveSystem,
  BossLore,
  TURNING_POINTS,
} from '@tangping/story';

export {
  // 数据层
  STORY_ARCS, STORY_CHARACTERS, WAVE_STORY, BOSS_DIALOG, LORE_ENTRIES,
  KEY_EVENTS, SIDE_STORIES, PERSPECTIVE_SCENES, BOSS_PROFILES,
  SOUND_MELODIES, STORY_VIDEO_SLOTS,
  TURNING_POINTS, CHAPTER_DEFS, CHAPTER_ACTS,
  // 运行时层
  createStoryRuntime, PIPELINE, PIPELINE_ORDER,
  setStoryHost, getStoryHost, hasInjectedHost, auditHost,
  createStoryPacing, StoryPacing, getPacing, setPacing,
  getLoreCodex, getAffinitySystem,
  registerLoreCodex, registerAffinitySystem,
  unlockLoreById, runtimeRefs, resetRuntimeCtx,
  // 系统本体（只读它们的 progress()/snapshot()）
  ChapterSystem, LoreCodex, SideStorySystem, KeyEventSystem,
  PerspectiveSystem, BossLore,
};

/**
 * 汇总叙事资产规模。第 3 步用它做「资产确实到位了」的联通性自证，
 * 也是将来防止「3D 版用了一份残缺数据」的哨兵。
 *
 * 刻意返回 Promise 而不是同步值：将来叙事资产可能改成
 * 远程加载 / 分包懒加载，调用方提前按异步写法适配，届时不用改调用点。
 */
export async function loadStoryManifest() {
  try {
    const size = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);
    const m = {
      ok: true,
      arcs: size(STORY_ARCS),
      characters: size(STORY_CHARACTERS),
      waveStories: size(WAVE_STORY),
      bossDialog: size(BOSS_DIALOG),
      loreEntries: size(LORE_ENTRIES),
      keyEvents: size(KEY_EVENTS),
      sideStories: size(SIDE_STORIES),
      perspectives: size(PERSPECTIVE_SCENES),
      bossProfiles: size(BOSS_PROFILES),
      melodies: size(SOUND_MELODIES),
      videoSlots: size(STORY_VIDEO_SLOTS),
    };
    // 数据规模为 0 说明 import 成功但内容是空的（比 import 失败更隐蔽）
    const critical = ['arcs', 'characters', 'waveStories', 'loreEntries'];
    const empties = critical.filter((k) => !m[k]);
    if (empties.length) {
      return { ok: false, error: `关键叙事数据为空：${empties.join(', ')}`, ...m };
    }
    return m;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 取某波次应该播放的剧情条目（第 5 步会用到，这里先定好接口形状）。
 * @param {number} wave
 */
export function waveStoryAt(wave) {
  if (!WAVE_STORY) return null;
  if (Array.isArray(WAVE_STORY)) return WAVE_STORY.find((w) => w.wave === wave) || null;
  return WAVE_STORY[wave] || null;
}
