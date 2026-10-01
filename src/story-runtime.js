// ============================================================
//  story-runtime.js —— 3D 侧的叙事运行时适配层
// ============================================================
//
// 这个文件做三件事：
//
//   1. **实现 StoryHost 接口** —— 把叙事包的抽象调用（showDialog / toast /
//      actCard / applyEffect / diary / collectFragment）落到 3D 侧的具体实现
//      （story-ui.js 的 UI + 3D 的 gb 游戏状态）。
//
//   2. **实现「人类可读奖励文案」的解析** —— 叙事数据里 applyEffect 收到的是
//      像「获得 620 金币、38 灵魂」这样的策划文案。2D 引擎有个
//      applyStoryEffect() 解析它；3D 侧需要自己的实现（规则数据结构不同）。
//
//   3. **接进波次钩子** —— 暴露 onWaveStart(wave)，由 main.js 在开波时调用。
//
// ── 为什么奖励要解析自由文案 ──────────────────────────────
//
//   900 行剧情数据里的 effect 全是策划手写的自由文本。改成结构化
//   （{ gold: 620, souls: 38 }）需要重写全部数据，而收益只是「解析少写 80 行」。
//   不值得。所以这里写一个**容错的正则解析器**：
//     · 认得出就加成，认不出就忽略并记一条 warn（不崩）
//     · 这样策划以后加新奖励类型，最坏情况是「这次没加成」，而不是「游戏崩了」
//
// ── 与 2D 引擎的一致性 ────────────────────────────────────
//
//   叙事**顺序**由包里的 runtime.js（PIPELINE）统一，两边跑同一份。
//   本文件只负责「3D 这边怎么把结果表现出来」。
// ============================================================

import {
  createStoryRuntime, auditHost, CHAPTER_DEFS, LORE_ENTRIES,
  SIDE_STORIES, KEY_EVENTS, TURNING_POINTS, PERSPECTIVE_SCENES,
} from '@tangping/story';

/** 认不出的奖励文案会落在这里（诊断用，重开一局清空） */
const _ignored = [];

/**
 * 解析叙事奖励文案。
 *
 * 支持的写法（覆盖现有全部剧情数据）：
 *   「获得 620 金币、38 灵魂」
 *   「获得 320 金币」「获得 450 金币」
 *   「永久护盾 +400」「全属性 +8%」「全属性 +15%」
 *   「床铺回满」「床铺回满血」
 *   「电力 +200」「获得 300 电力」
 *   「解锁世界观词条」「周默好感度 +1」
 *
 * @param {string} spec
 * @param {object} gb  3D 的游戏板（直接改它）
 * @returns {{applied:string[], ignored:boolean}}
 */
export function applyEffectText(spec, gb) {
  const applied = [];
  if (!spec || typeof spec !== 'string' || !gb) return { applied, ignored: true };
  const s = spec;

  // 取第一个数字（允许逗号分隔）
  const num = (re) => {
    const m = s.match(re);
    return m ? parseFloat(String(m[1]).replace(/,/g, '')) : null;
  };

  // ── 金币 ──
  const gold = num(/金币\s*([\d,]+)/) ?? num(/([\d,]+)\s*金币/);
  if (gold) { gb.gold += gold; applied.push(`+${gold}💰`); }

  // ── 灵魂 ──
  const souls = num(/([\d,]+)\s*灵魂/);
  if (souls) { gb.souls += souls; applied.push(`+${souls}🔮`); }

  // ── 电力 ──
  const power = num(/([\d,]+)\s*(?:点)?电力/);
  if (power) { gb.power += power; applied.push(`+${power}⚡`); }

  // ── 床铺回满 ──
  if (/床铺回满|床回满|床铺血量回满/.test(s)) {
    gb.bed.hp = gb.bed.maxHp;
    applied.push('床铺回满');
  }

  // ── 永久护盾 ──
  const shield = num(/护盾\s*\+?\s*([\d,]+)/);
  if (shield) {
    // 3D 里「永久护盾」落到床铺的护盾上限上（2D 的等价语义）
    if (typeof gb.bed.shield === 'number') gb.bed.shield += shield;
    else gb.bed.shield = (gb.bed.shield || 0) + shield;
    applied.push(`护盾 +${shield}`);
  }

  // ── 全属性百分比 ──
  // ⚠️ 3D 的规则层没有「全属性百分比」这个字段（2D 有 buff 系统）。
  //    这里落到 gb.buff 上，由规则层读取（rules 里 buff.dmgBoost 已经存在）。
  const pct = num(/全属性\s*\+?\s*(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    if (!gb.buff) gb.buff = { goldBoost: 0, dmgBoost: 0 };
    gb.buff.dmgBoost = (gb.buff.dmgBoost || 0) + pct / 100;
    gb.buff.goldBoost = (gb.buff.goldBoost || 0) + pct / 100;
    applied.push(`全属性 +${pct}%`);
  }

  // ── 好感度（3D 没有好感度系统，但不应报错；记下来让日记有痕迹）──
  const aff = num(/好感度\s*\+?\s*(\d+)/);
  if (aff) applied.push(`好感度 +${aff}`);

  // ── 解锁词条（由叙事包自己处理词条集，这里只确认不报错）──
  if (/解锁世界观词条|解锁设定/.test(s)) applied.push('解锁词条');

  return { applied, ignored: applied.length === 0 };
}

/**
 * 造一个 3D 的叙事宿主。
 *
 * @param {object} deps
 *   ui       —— story-ui.js 的返回值（必须有 showDialog/toast/actCard 的等价物）
 *   gb       —— 3D 的游戏板
 *   onEnding —— 需要判定结局时调用（第 60 波）
 *   onFlags  —— { get(key), set(key, val) }
 */
export function createStoryHost({ ui, gb, onEnding, onFlags }) {
  const ignoreLog = [];

  return {
    name: 'tangping-3d',

    showDialog(d) { ui.push(d); },
    toast(title, body, tone, seconds) { ui.toast(title, body, tone, seconds); },
    actCard(label, title, question) { ui.showAct(label, title, question); },

    applyEffect(spec) {
      const r = applyEffectText(spec, gb);
      if (r.ignored) ignoreLog.push(spec);
      else ui.toast('🎁 剧情奖励', r.applied.join(' · '), 'gold', 5);
      return r;
    },

    collectFragment(id) {
      // 3D 暂时没有碎片系统（2D 的 DreamFragments 依赖 DOM 弹窗演出）。
      // 记账不丢：写进 gb.fragments，将来做碎片面板时直接读。
      if (!gb.fragments) gb.fragments = [];
      if (!gb.fragments.includes(id)) {
        gb.fragments.push(id);
        ui.toast('🧩 梦境碎片', id, 'blue', 4);
      }
    },

    diary(kind, text) {
      // 3D 的日记就是 story-ui 的面板 + 一个内存环形缓冲。
      // 保留最近 200 条即可 —— 日记是给玩家「回顾」用的，不是审计日志。
      if (!gb.diary) gb.diary = [];
      gb.diary.push({ kind, text, wave: gb.wave || 0, t: Date.now() });
      if (gb.diary.length > 200) gb.diary.splice(0, gb.diary.length - 200);
    },

    getFlag(key) {
      if (onFlags) return onFlags.get(key);
      return gb[key];
    },
    setFlag(key, val) {
      if (onFlags) onFlags.set(key, val);
      else gb[key] = val;
    },

    /** 本适配层忽略掉的奖励文案（调试用 —— 认不出的文案会落在这里） */
    get ignoredEffects() { return ignoreLog; },
  };
}

/**
 * 组装 3D 的叙事运行时。
 *
 * @param {object} o
 *   ui    —— story-ui.js 返回值
 *   gb    —— 游戏板
 *   onWaveStory(result) —— 本波叙事的摘要（main.js 用来刷新 HUD / 记录）
 *   onEnding(stats)     —— 第 60 波结束时判定结局
 */
export function createNarrative({ ui, gb, onWaveStory, onEnding }) {
  const host = createStoryHost({
    ui, gb,
    onEnding,
    onFlags: { get: (k) => gb[k], set: (k, v) => { gb[k] = v; } },
  });

  const runtime = createStoryRuntime({ host, onWaveStory });

  // 自检：宿主少实现一个能力，表现是「剧情静默丢失」——启动期就该发现。
  const audit = auditHost();
  if (!audit.ok) {
    console.warn('[story-runtime] 宿缺少能力：', audit.missing, '（这些通道的剧情将不会显示）');
  }

  return {
    runtime,
    host,
    audit,

    /** main.js 在开波时调它 */
    onWaveStart(wave) {
      return runtime.onWaveStart(wave);
    },

    /** 组装日记面板需要的数据 */
    panelData() {
      const p = runtime.progress();
      const snap = runtime.snapshot();
      const cur = p.currentChapter;
      return {
        chapters: p.chapters,
        currentChapter: cur,
        act: cur ? Object.assign({ label: `第 ${p.actIndex} 幕` }, findAct(cur)) : null,
        chapterList: CHAPTER_DEFS.map((c) => ({
          title: c.title, summary: c.summary,
          reached: (snap.chapters.reached || []).includes(c.id),
        })),
        lore: p.lore,
        loreList: LORE_ENTRIES.map((e) => ({ def: e, unlocked: (snap.lore || []).includes(e.id) })),
        side: p.side,
        sideList: SIDE_STORIES.map((s) => ({
          def: s,
          step: (snap.side.progress || {})[s.id] || 0,
          total: s.stages.length,
          done: !!(snap.side.done || {})[s.id],
        })),
        eventProg: p.events,
        perspProg: p.perspectives,
        diary: (gb.diary || []).slice(-40).reverse(),
        fragments: gb.fragments || [],
      };
    },

    /** 本局叙事统计（结局画面用） */
    stats() {
      const p = runtime.progress();
      return {
        chapters: p.chapters.reached,
        sideDone: p.side.done,
        sideTotal: p.side.total,
        eventsFired: p.events.fired,
        perspectivesFired: p.perspectives.fired,
        loreUnlocked: p.lore.unlocked,
        loreTotal: p.lore.total,
        fragments: (gb.fragments || []).length,
      };
    },

    snapshot: () => runtime.snapshot(),
    restore: (s) => runtime.restore(s),
    reset: () => { runtime.reset(); _ignored.length = 0; },
    get waveLog() { return runtime.waveLog; },
    /** 本适配层忽略掉的奖励文案（诊断用 —— 认不出的会落在这里） */
    get ignoredEffects() { return _ignored; },
  };
}

// 找幕定义的兜底（CHAPTER_DEFS 里有 act id，但幕标题在包内不导出；
// 用一个极小的本地映射避免为了一个标签去改包的导出面）
const ACT_LABEL = {
  'night-watch': { title: '床边的第四声', question: '门外三声之后，床边那一声是谁敲的？' },
  'the-record': { title: '倒放的值夜表', question: '记录为什么先写了「回来」，再写「出发」？' },
  'the-empty-place': { title: '空位属于谁', question: '照片里的空位，真的是少了一个人吗？' },
  'the-lamp': { title: '灯一直亮着', question: '朋友回来以后，为什么梦还在等？' },
  'the-reply': { title: '听完那条语音', question: '这一次，你愿意亲口回答吗？' },
};
function findAct(ch) {
  const a = ACT_LABEL[ch.act];
  return a ? { title: a.title, question: a.question } : { title: '', question: '' };
}

export function ignoredEffectTexts() { return _ignored; }

// 重新导出，方便 main.js 一处 import
export { CHAPTER_DEFS, LORE_ENTRIES, SIDE_STORIES, KEY_EVENTS, TURNING_POINTS, PERSPECTIVE_SCENES };
