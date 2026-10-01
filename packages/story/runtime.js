// ============================================================
//  runtime.js —— 叙事运行时总装（跨 2D / 3D 共用）
// ============================================================
//
// 这个文件把散落在各处的叙事系统按**固定顺序**串成一条波次管线。
//
// ── 为什么必须有这个文件 ──────────────────────────────────
//
//   2D 引擎里这段顺序硬写在 dream.js 的 onWaveStart()（第 2126-2174 行）：
//
//     ChapterSystem → LoreCodex → SideStorySystem → KeyEventSystem →
//     PerspectiveSystem → LetterSystem
//
//   这个顺序**不是随手排的**：
//     · 章节先跑，因为幕卡是「舞台提示」，必须先于台词出现；
//     · 插叙最后跑，因为它的优先级最低，要让位于别人的预算；
//     · 事件在支线之后，因为事件里含「幕间小结」这种必播的结构节点，
//       它需要先把预算占掉，剩下的空隙才给插叙。
//
//   3D 侧如果把这段顺序抄一遍，两边就会慢慢漂移 —— 而「节奏」正是
//   这类游戏最容易被无声破坏的东西（不会报错，只是变得不好玩）。
//
//   所以把顺序本身做成**数据**（PIPELINE 数组），两个宿主都跑同一个函数。
//
// ── 与 2D 引擎的关系 ──────────────────────────────────────
//
//   2D 引擎**不必**改成调用本文件 —— 它现在的全局版本能跑，动它是风险。
//   本文件是给 3D 用的，同时也是两边行为的**规格说明**：
//   如果哪天发现两者节奏不一致，对照 PIPELINE 就能立刻看出哪边漂了。
// ============================================================

import { getStoryHost, setStoryHost } from './host.js';
import { getPacing, setPacing, resetRuntimeCtx } from './runtime-ctx.js';
import { ChapterSystem } from './chapters.js';
import { LoreCodex } from './lore.js';
import { SideStorySystem } from './sidestories.js';
import { KeyEventSystem } from './events.js';
import { PerspectiveSystem } from './perspectives.js';
import { WAVE_STORY, BOSS_DIALOG } from './story.js';
import { BossLore } from './bosslore.js';

/**
 * 波次管线的**权威顺序**。
 *
 * ⚠️ 每一项的 `why` 记录了「为什么排在这里」—— 改动顺序前先读它。
 *    顺序错了不会报错，只会让节奏悄悄变差，极难回查。
 */
const PIPELINE = [
  {
    id: 'chapter', label: '章节推进',
    why: '最先跑：幕卡是舞台提示，必须先于台词出现；同一章内不重复提示。',
    run(wave) { return ChapterSystem.checkWave(wave); },
  },
  {
    id: 'lore', label: '词条解锁',
    why: '与剧情独立：到波次就该进设定集，不占用对白预算。',
    run(wave) { return LoreCodex.unlockByWave(wave); },
  },
  {
    id: 'side', label: '支线剧情',
    why: '自带波次避让，只插在主线没占用的波次；每波最多一段。',
    run(wave) { return SideStorySystem.checkWave(wave); },
  },
  {
    id: 'event', label: '关键事件',
    why: '在支线之后：事件含「幕间小结」这种必播结构节点，要先占预算。',
    run(wave) { return KeyEventSystem.checkWave(wave); },
  },
  {
    id: 'perspective', label: '视角插叙',
    why: '最后跑：优先级最低，所以最先让位于波次预算（剩余空隙才给它）。',
    run(wave) { return PerspectiveSystem.checkWave(wave); },
  },
];

/** 管线里所有系统的 id（校验器用来断言顺序没被改） */
export const PIPELINE_ORDER = PIPELINE.map((p) => p.id);

/**
 * 一局的叙事运行时。
 *
 * ⚠️ 为什么是工厂而不是单例：
 *   叙事系统的进度（支线推进到第几段、已触发的章节）是**每局独立**的。
 *   3D 侧重开一局必须彻底清空，否则第二局会「一开场就已经在第三幕」。
 *   2D 引擎用全局单例没出问题，是因为它重开时走的是整页刷新 ——
 *   3D 是 SPA 风格的重开，不能靠刷新。
 */
export function createStoryRuntime({ host, onWaveStory } = {}) {
  if (host) setStoryHost(host);
  setPacing();               // 每个运行时一份独立的预算实例
  resetChapterAndStorySystems();

  let _lastWave = -1;
  const _log = [];
  /** 本局每次波次触发的记录（校验/调试用） */
  const _waveLog = [];

  return {
    /** 当前生效的预算实例（校验器要读它） */
    get pacing() { return getPacing(); },

    get lastWave() { return _lastWave; },
    get log() { return _log; },
    get waveLog() { return _waveLog; },

    /**
     * 波次开始钩子。**这是 3D 侧唯一需要调的叙事入口。**
     *
     * @param {number} wave 新波次号（从 1 开始）
     * @returns {object} 本波触发了什么（供 HUD / 校验器读）
     */
    onWaveStart(wave) {
      if (wave === _lastWave) {
        // 同一波重复调用（比如暂停后恢复又跑了一次钩子）不应该重复播剧情。
        // 2D 引擎靠整页刷新天然规避了这个问题，3D 不行。
        return { wave, duplicated: true, chapter: null, lore: [], side: [], event: [], perspective: [], main: null };
      }
      _lastWave = wave;

      const hostRef = getStoryHost();
      const before = getPacing().used();
      const result = { wave, chapter: null, lore: [], side: [], event: [], perspective: [], main: null };

      // ── 0) 主线对白：WAVE_STORY 到波就播，不参与预算 ──
      //     它是「本波该看的东西」，是预算的**前提**而非竞争者。
      const mainEntry = findWaveStory(wave);
      if (mainEntry) {
        result.main = mainEntry;
        hostRef.showDialog({
          wave,
          speaker: mainEntry.speaker || '旁白',
          text: mainEntry.text,
          choices: mainEntry.choices,
          kind: 'main',
          // ⚠️ sceneId 必须透传！
          //    它是「这一段对白配哪个镜头」的唯一凭据。WAVE_STORY 里
          //    第 1/10/32/47/55/60 波各带一个 sceneId，但宿主的播放层
          //    看不到 WAVE_STORY —— 它只看 showDialog 收到的这一份数据。
          //    漏传的后果是**静默的**：剧情照常播、文字照常显示，
          //    只是视频永远不出现（因为 slot 查不到）。极难排查。
          sceneId: mainEntry.sceneId || null,
        });
        hostRef.diary('story', '主线 · 第 ' + wave + ' 波：' + (mainEntry.speaker || '旁白'));
      }

      // ── 1) BOSS 出场对白（有就播，同样是结构性节点）──
      const bossEntry = findBossDialog(wave);
      if (bossEntry) {
        result.boss = bossEntry;
        hostRef.showDialog({
          wave,
          speaker: bossEntry.speaker || bossEntry.name || '???',
          text: bossEntry.text || bossEntry.phase1 || '',
          choices: bossEntry.choices,
          kind: 'boss',
        });
      }

      // ── 2) 管线：章节 → 词条 → 支线 → 事件 → 插叙 ──
      for (const step of PIPELINE) {
        let out = null;
        try {
          out = step.run(wave);
        } catch (e) {
          // 单个系统出错不能带塌整条管线 —— 叙事是「锦上添花」，
          // 战斗是「雪中送炭」。宁可少播一段剧情，也不能让游戏卡死。
          console.warn('[story-runtime] ' + step.id + ' 失败:', e);
          out = null;
        }
        if (step.id === 'chapter') result.chapter = out;
        else if (step.id === 'lore') result.lore = out || [];
        else if (step.id === 'side') result.side = out || [];
        else if (step.id === 'event') result.event = out || [];
        else if (step.id === 'perspective') result.perspective = out || [];
      }

      // 本波一共播了几段对白（不含主线/BOSS，它们不占预算）
      result.dialogCount =
        (result.main ? 1 : 0) + (result.boss ? 1 : 0)
        + (result.side.length || 0)
        + (result.event.filter?.((e) => e.show)?.length || 0)
        + (result.perspective.length || 0);
      result.budgetUsed = getPacing().used() - before;
      result.budget = getPacing().budget(wave);

      _waveLog.push(result);
      if (onWaveStory) {
        try { onWaveStory(result); } catch (e) { console.warn('[story-runtime] onWaveStory:', e); }
      }
      return result;
    },

    /** BOSS 阶段台词（战斗中用） */
    bossLine(key, phase) { return BossLore.line ? BossLore.line(key, phase) : null; },
    bossDefeatLine(key) { return BossLore.defeatLine(key); },

    /** 进度快照（HUD / 校验器用） */
    progress() {
      return {
        chapters: ChapterSystem.progress(),
        lore: LoreCodex.progress(),
        side: SideStorySystem.progress(),
        events: KeyEventSystem.progress(),
        perspectives: PerspectiveSystem.progress(),
        actIndex: ChapterSystem.actIndex(_lastWave > 0 ? _lastWave : 1),
        currentChapter: ChapterSystem.current(),
      };
    },

    /** 存档：所有叙事系统状态的合并快照 */
    snapshot() {
      return {
        wave: _lastWave,
        chapters: ChapterSystem.snapshot(),
        lore: LoreCodex.snapshot(),
        side: SideStorySystem.snapshot(),
        events: KeyEventSystem.snapshot(),
        perspectives: PerspectiveSystem.snapshot(),
      };
    },

    /** 读档 */
    restore(snap) {
      if (!snap) return;
      _lastWave = typeof snap.wave === 'number' ? snap.wave : -1;
      ChapterSystem.restore(snap.chapters);
      LoreCodex.restore(snap.lore);
      SideStorySystem.restore(snap.side);
      KeyEventSystem.restore(snap.events);
      PerspectiveSystem.restore(snap.perspectives);
    },

    /** 重开一局 */
    reset() {
      resetChapterAndStorySystems();
      resetRuntimeCtx();
      _lastWave = -1;
      _waveLog.length = 0;
    },
  };
}

// ── 内部工具 ─────────────────────────────────────────────────

/** 把所有有状态的叙事系统清空 */
function resetChapterAndStorySystems() {
  try { ChapterSystem.reset(); } catch (e) {}
  try { LoreCodex.init(); } catch (e) {}
  try { SideStorySystem.reset(); } catch (e) {}
  try { KeyEventSystem.reset(); } catch (e) {}
  try { PerspectiveSystem.reset(); } catch (e) {}
  try { BossLore.reset(); } catch (e) {}
}

/** 找某波的主线对白 */
function findWaveStory(wave) {
  if (!Array.isArray(WAVE_STORY)) return null;
  return WAVE_STORY.find((s) => s.wave === wave) || null;
}

/** 找某波的 BOSS 出场对白 */
function findBossDialog(wave) {
  if (!BOSS_DIALOG || typeof BOSS_DIALOG !== 'object') return null;
  for (const key of Object.keys(BOSS_DIALOG)) {
    const d = BOSS_DIALOG[key];
    if (d && d.wave === wave) return Object.assign({ key }, d);
  }
  return null;
}

export { PIPELINE };
