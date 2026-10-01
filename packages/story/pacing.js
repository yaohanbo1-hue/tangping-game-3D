// ============================================================
//  pacing.js —— 波次剧情预算（StoryPacing）
// ============================================================
//
// 从 2D 引擎（vendor-engine.js 第 583-665 行）抽出来的共享实现。
// 2D 与 3D 必须用**同一份**预算逻辑，否则两边的剧情节奏会不一致 ——
// 而「节奏」正是这个模块存在的唯一理由。
//
// ── 为什么需要它 ─────────────────────────────────────────
//
//   支线 / 关键事件 / 视角插叙各自都有「每波最多一段」的限制，
//   但三条线加起来，再叠上主线的 WAVE_STORY，同一波就可能连播 4-5 段对白。
//   实测第 20 波（主线 + 幕间小结 + 支线 + 插叙）就是这样，严重打断战斗节奏。
//
//   所以给「本波还能播几段对白」设一个共享预算：
//     · 幕交界波次 → 只留 1 个名额（该波已有主线 + 幕间小结两段）
//     · 主线波     → 留 1 个名额
//     · 空闲波     → 留 3 个名额
//   幕间转折（priority）不占预算 —— 它是结构型节点，到点必播。
//
//   优先级由**调用顺序**决定：章节 > 事件 > 支线 > 插叙
//   （插叙最后调用，所以最先让位）。
//
// ⚠️ 这里的「占用表」（WAVE_STORY / TURNING_POINTS）从本包的数据模块读，
//    不再靠全局 typeof 探测 —— 数据就在同一个包里，没有理由外求。
// ============================================================

import { WAVE_STORY } from './story.js';
import { TURNING_POINTS } from './events.js';

/** 某个波次是否已有主线对白 */
function hasMainStory(wave) {
  return Array.isArray(WAVE_STORY) && WAVE_STORY.some((s) => s.wave === wave);
}

/** 某个波次是否落在幕交界（有 priority 幕间小结） */
function isTurningWave(wave) {
  return Array.isArray(TURNING_POINTS) && TURNING_POINTS.some((t) => t.wave === wave);
}

/**
 * ⚠️ 这个对象是**有状态的**（记录本波已用名额）。
 *
 * 2D 引擎里它是全局单例，靠 `StoryPacing.take(wave)` 调用。
 * 3D 侧要的是「每个存档独立」，所以导出了一个 createStoryPacing() 工厂，
 * 但同时也保留这个默认单例给 2D 引擎用（零改动）。
 */
function makePacing() {
  return {
    _wave: -1,
    _count: 0,

    /** 进入新波次时重置计数（各系统在 checkWave 开头调用） */
    begin(wave) {
      if (this._wave !== wave) { this._wave = wave; this._count = 0; }
    },

    /**
     * 该波次允许的剧情段数上限。
     *
     * ⚠️ 必须扣掉「幕间小结」：它带 priority、不占预算就触发了，
     *    但同样是一段对白。不扣的话，幕交界波次会变成
     *    主线 + 幕间小结 + 预算内 2 段 = 4 段对白（实测第 40 波就是这样）。
     */
    budget(wave) {
      // 幕交界波次：已有主线 + 幕间小结两段，只再留 1 个名额（终幕事件要靠它排进去）
      if (isTurningWave(wave)) return 1;
      // 主线波留 1 个名额；空闲波留 3 个 —— 空闲波没有主线对白，多一两段不会显得吵。
      // 之所以要给到 3：剧情节点总数已经超过基础名额，
      // 尾段（第 48-60 波）有大量节点抢有限名额，靠逾期放宽兜不住。
      return hasMainStory(wave) ? 1 : 3;
    },

    /** 该波是否落在幕交界 */
    isTurning(wave) { return isTurningWave(wave); },

    /**
     * 本波还能不能再播一段。
     * @param {number} wave
     * @param {number} [overdueBy] - 候选节点已经逾期多少波（wave - prefer）
     *
     * 为什么需要逾期放宽：
     *   预算总量有限，而剧情节点总数会随内容扩充持续增长。一旦节点数
     *   超过名额数，排在最后的几条就会被永远卡住 —— 这是实测出来的：
     *   88 个节点 vs 84 个名额，结果 3 条支线和 1 段插叙到第 60 波都没播。
     *   所以按逾期程度分档放宽，让排期自适应内容量：
     *     逾期 < 4 波   → 严格按预算（保持节奏）
     *     逾期 ≥ 4 波   → 放宽 1 个名额
     *     逾期 ≥ 10 波  → 再放宽 1 个（避免内容彻底播不出来）
     */
    canPlay(wave, overdueBy) {
      this.begin(wave);
      const b = this.budget(wave);
      if (this._count < b) return true;
      // 幕交界波次不接受逾期放宽 —— 否则会叠成「主线 + 小结 + 3 段」共 5 段对白
      if (this.isTurning(wave)) return false;
      const od = overdueBy || 0;
      const extra = od >= 10 ? 2 : (od >= 4 ? 1 : 0);
      // 硬上限 4：即使逾期放宽叠加，也不让单波超过 4 段对白
      return this._count < Math.min(b + extra, 4);
    },

    /** 占用一个名额 */
    take(wave) { this.begin(wave); this._count++; },

    /** 本波已用名额（调试/校验用） */
    used() { return this._count; },

    reset() { this._wave = -1; this._count = 0; },
  };
}

/** 默认单例（2D 引擎沿用；3D 建议用 createStoryPacing 自己持有一份） */
const StoryPacing = makePacing();

export { StoryPacing, makePacing as createStoryPacing };
export { hasMainStory, isTurningWave };
