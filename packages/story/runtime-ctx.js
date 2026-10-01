// ============================================================
//  runtime-ctx.js —— 叙事运行时的共享上下文
// ============================================================
//
// 解决什么问题：
//
//   叙事运行时里有几个东西是「多个系统都要用，但谁都不该拥有」：
//     · StoryPacing  —— 波次预算，章节/事件/支线/插叙共用一份
//     · LoreCodex    —— 词条解锁，事件/支线/插叙都要往里写
//
//   如果让 sidestories.js 直接 `import { LoreCodex } from './lore.js'`，
//   而 lore.js 又要 `import { getStoryHost }`，
//   一旦将来 lore 需要读支线进度，就成了循环依赖。
//
//   所以把这些「共享单例」集中到一个**极薄的注册点**，
//   各系统通过它拿引用，而不是彼此直接 import。
//
// 这是有意的架构选择，不是过度设计：
//   叙事包有 6 个数据模块 + 5 个运行时系统，它们之间的依赖图
//   已经是网状的了。有了这个文件，网状就变成了星型。
// ============================================================

import { getStoryHost } from './host.js';
import { StoryPacing, createStoryPacing } from './pacing.js';

/** 当前生效的预算实例（默认单例；3D 可以换成自己的一份） */
let _pacing = StoryPacing;

/** 词条解锁器。由 lore.js 在加载时注册进来（避免循环依赖） */
let _loreCodex = null;

/** 好感度系统。由 characters.js 在加载时注册进来（2D 有、3D 可以没有） */
let _affinity = null;

/** lore.js 加载时调用，把自己注册进来 */
export function registerLoreCodex(codex) {
  _loreCodex = codex;
  return codex;
}

/** characters.js 加载时调用，把自己注册进来（可选） */
export function registerAffinitySystem(sys) {
  _affinity = sys;
  return sys;
}

/** 取词条解锁器（可能为 null —— 数据模块可单独使用） */
export function getLoreCodex() { return _loreCodex; }

/**
 * 转出宿主接口 —— 让**生成的数据模块**（events/sidestories/perspectives/lore）
 * 也能拿到宿主，而不必各自 import host.js。
 *
 * 为什么要有这个转发：
 *   那几个文件是 `make-story-package.cjs` 从仓库根的源文件生成的
 *   （只在末尾追加 export）。生成器注入 import 时只认「来自 runtime-ctx」
 *   这一个来源，这样源文件保持「纯数据 + 少量逻辑」，不必自己写 import
 *   语句，也就不会被手写 import 和生成 import 搞成重复导入。
 */
export { getStoryHost };

/** 取好感度系统（2D 有、3D 未必有，所以可能为 null） */
export function getAffinitySystem() { return _affinity; }

/** 取当前的波次预算 */
export function getPacing() { return _pacing; }

/**
 * 换一份预算实例（3D 侧每个存档独立一份）。
 * @param {object} [pacing] 省略则新建一份
 */
export function setPacing(pacing) {
  _pacing = pacing || createStoryPacing();
  return _pacing;
}

/**
 * 解锁一个词条 —— 统一入口。
 *
 * 为什么不让各系统自己 import LoreCodex：
 *   1. 避免循环依赖（见文件头）；
 *   2. 词条系统可能不存在（数据模块可以单独使用），所以要能优雅降级；
 *   3. 只在**一个地方**决定「解锁要不要提示玩家」，行为一致。
 *
 * @param {string} id
 * @param {object} [host] 省略则现取
 * @returns {object|null} 解锁到的词条定义
 */
export function unlockLoreById(id, host) {
  if (!id || !_loreCodex) return null;
  const h = host || getStoryHost();
  // silent=true：提示由下面统一发，避免「解锁时提示 + 这里又提示」重复两条
  const entry = _loreCodex.unlock(id, true);
  if (!entry) return null;
  h.toast(entry.icon + ' 解锁设定', entry.title + ' — ' + entry.brief, 'gold', 6);
  return entry;
}

/** 一次性取全部运行时单例（调试面/校验器用） */
export function runtimeRefs() {
  return { pacing: _pacing, loreCodex: _loreCodex };
}

/** 重置共享状态（新开一局时调用） */
export function resetRuntimeCtx() {
  _pacing.reset();
}
