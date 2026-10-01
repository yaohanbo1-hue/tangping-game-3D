// ============================================================
//  ending.js —— 结局判定（6 个结局 + 跨局成就）
// ============================================================
//
// 从 2D 引擎的 EndingSystem 移植（vendor-engine.js:929-1130）。
// **结局数据逐字保留** —— 这是叙事资产，改一个字都是创作决策而不是移植决策。
//
// ── 移植中唯一需要重写的地方：buildContext() ────────────────
//
//   2D 版的 buildContext() 直接读全局 `G` / `AffinitySystem` /
//   `MercyPath` / `DreamFragments` —— 那是一堆靠 typeof 判空才敢碰的全局。
//   3D 侧没有这些东西，所以改成**从叙事运行时的 progress() 组装**：
//
//     2D 全局                3D 的来源
//     ─────────────────      ──────────────────────────────────
//     G.wave / G.mode        gb.wave / 固定 'limited'
//     AffinitySystem.list()  narrative.progress().affinity（若无则空）
//     MercyPath._completed   叙事事件的 effect 标记（本移植版从 diary 统计）
//     DreamFragments         host.collectFragment 记下的 gb.fragments
//     SideStorySystem        narrative.progress().side
//     LoreCodex              narrative.progress().lore
//
//   ⚠️ 「好感度」与「理解路线」在 3D 里**没有对应的运行时系统** ——
//      它们原本挂在 2D 的 G.affection 与 MercyPath 上，而那两套东西
//      是 2D 引擎的全局状态，第 5 步没把它们一起搬过来（搬过来就要
//      连带搬它们的 UI 与触发时机，那是另一整块工作）。
//
//      所以 3D 版的判定会**系统地**把 maxAffinity 与 mercyDone 读成 0，
//      结果是 end_sleep（再睡五分钟）几乎必然命中。
//
//      本文件**不**为了让结局"好看"而伪造这两个数值 —— 那等于骗玩家。
//      正确的做法是：这两个系统缺失时要**显式暴露**（progress 里报 null /
//      ending.js 里打 warn），让「3D 版还没有好感度系统」这件事
//      在验收时看得见，而不是表现为「怎么每次都出同一个结局」。
//
// ── 判定顺序（务必小心）────────────────────────────────────
//   ENDING_DEFS 按 rank 升序取**第一个满足条件的**。
//   rank=1 门槛最高，rank=99 是兜底。顺序错了，兜底会抢先命中，
//   高门槛结局永远拿不到 —— 这个坑 2D 版踩过一次（见 end_sleep
//   上方的注释），所以这里保留了原始 rank 值，一个都没动。
// ============================================================

import { unlockEnding, loadMeta } from './save.js';

// ══════════════════════════════════════════════════════════
//  1. 结局定义（数据逐字移植自 vendor-engine.js）
// ══════════════════════════════════════════════════════════

export const ENDING_DEFS = [
  {
    id: 'end_photo', rank: 1, tone: 'legend',
    title: '四个人的合照', icon: '📷',
    subtitle: '你终于看清了照片里第四个人的脸',
    conditionText: '通关 + 三位室友全部达到「羁绊」+ 完成全部支线 + 设定解锁 ≥ 40',
    check: (c) => c.allBonded && c.sideDoneAll && c.loreUnlocked >= 40,
    text:
      '你把闹钟按停了。\n'
      + '指针没有动 —— 它本来就不需要动，因为它从来没有快过，也没有慢过。\n'
      + '三个人从床边退开半步，给你留出下床的位置。\n'
      + '小夏把灯提起来照了照，周默合上值夜表，赵磊把那个笑话的结尾又念了一遍，'
      + '这次没有人打断他。\n'
      + '你低头看自己的手腕 —— 手环上的名字清晰得像是刚刻上去的。\n'
      + '窗外天光泛白，走廊尽头第一次有了尽头。',
    epilogue:
      '后来那张合照被重新拍了一次。\n'
      + '四个人站在 307 门口，谁也没有躲在被子里。\n'
      + '背面写着一行新字：「这次点过名了，四个都在。」\n'
      + '老陈把这张照片压进了铁皮柜最底下 —— 和上一届那张放在一起。',
    reward: '获得 30000 金币、获得 600 灵魂、全属性 +20%',
  },
  {
    id: 'end_fragments', rank: 2, tone: 'violet',
    title: '三十块碎片', icon: '💎',
    subtitle: '你把散落的记忆全部拼了回来',
    conditionText: '通关 + 收集全部 30 枚记忆碎片',
    check: (c) => c.fragTotal > 0 && c.fragCollected >= c.fragTotal,
    text:
      '三十块碎片在你面前铺开。\n'
      + '它们没有拼出一扇门，也没有拼出一条出口 —— 拼出来的是一张床，'
      + '和三个站在床边的人。\n'
      + '每一块碎片里都有你自己，只是年纪不同、表情不同。\n'
      + '最旧的那一块几乎透明，上面只有一句话：「别怕，我们都在。」',
    epilogue:
      '你把这些碎片按时间排好，发现它们刚好覆盖了从 03:07 到 03:14 的七分钟。\n'
      + '一秒不多，一秒不少。\n'
      + '原来那七分钟一直都在，只是被拆成了三十份，等你一份一份捡回来。',
    reward: '获得 25000 金币、获得 500 灵魂、床铺回复至满血',
  },
  {
    id: 'end_lamp', rank: 3, tone: 'cyan',
    title: '灯一直亮着', icon: '💡',
    subtitle: '你选择了理解，而不是击杀',
    conditionText: '通关 + 完成至少 5 次「理解路线」',
    check: (c) => c.mercyDone >= 5,
    text:
      '那些本该被你打散的梦魇，一个接一个说了它们最后一句话。\n'
      + '有的说「我只是想被看见」，有的说「我忘了自己是谁」，'
      + '还有一只什么也没说，只是朝你点了点头。\n'
      + '它们消散的时候没有留下碎片，只在原地留了一小片光。\n'
      + '你把那些光收在一起，发现它们正好够点亮床头那盏应急灯。',
    epilogue:
      '你终于明白「灯律」的另一半含义：\n'
      + '灯亮着的地方梦魇无法成形 —— 因为灯亮着的地方，'
      + '本来就没有梦魇，只有还没被听完的话。\n'
      + '你听完了一句，就少了一只。',
    reward: '获得 20000 金币、获得 400 灵魂、免疫控制（本局）',
  },
  {
    id: 'end_answer', rank: 4, tone: 'gold',
    title: '亲口回答', icon: '🗣️',
    subtitle: '这一次，你愿意回答他们了',
    conditionText: '通关 + 至少一位室友达到「羁绊」档位（好感度 ≥ 10）',
    check: (c) => c.maxAffinity >= 10,
    text:
      '小夏没有催你开门。她只是站在灯下，等你自己开口。\n'
      + '你张了张嘴 —— 这次没有录音机抢在你前面。\n'
      + '「我听见了。」你说，「灯放好了，我听见了。」\n'
      + '赵磊愣了两秒，然后笑得比任何时候都大声。周默低下头，'
      + '在值夜表的最后一行慢慢画了一个勾。',
    epilogue:
      '你后来才知道，那句「我听见了」是这场梦唯一一次由你主动说出的话。\n'
      + '前面的六十分钟里，你一直在守门、在升级、在把墙垒高。\n'
      + '而真正让梦结束的，是四个字。',
    reward: '获得 22000 金币、获得 450 灵魂、全属性 +15%',
  },
  {
    // ⚠️⚠️ 这个结局的**数组位置**和 **rank** 是两件不同的事，别搞混：
    //
    //   rank = 99  只用于 `sorted.find(...)` 的**优先级排序**。
    //              虽然写着「兜底」，但因为它排在 end_sleep(rank 5) 之后，
    //              实际上只有在 end_sleep 的条件不满足时才可能命中，
    //              而 end_sleep 的条件（maxAffinity<3 且 mercyDone===0）
    //              几乎覆盖了所有「没走理解路线也没建立关系」的情况。
    //              ⇒ **end_wake 在实际判定里基本不可达**，这是设计意图：
    //                「守到天亮」是一个理想化的基调结局，不该随手就给。
    //
    //   数组位置    决定了 `ENDING_DEFS[ENDING_DEFS.length - 1]` 是谁 ——
    //              那是 `sorted.find()` 全部落空时的**最后兜底**。
    //              2D 版刻意把 end_sleep 放在数组末尾，让这个「理论上
    //              不可能发生的兜底」落到最冷的那个结局上。
    //
    //   这条注释是移植时踩出来的：我第一版按 rank 顺序排成
    //   [..., end_answer, end_sleep(5), end_wake(99)]，
    //   结果数组末尾变成了 end_wake，兜底语义就和 2D 不一样了。
    //   「排序」看不出这个差别（sort 之后两者顺序相同），
    //   只有逐项比对**数组原序**才能抓到 —— 所以校验脚本比对的是原序。
    id: 'end_wake', rank: 99, tone: 'blue',
    title: '醒来', icon: '🌅',
    subtitle: '你守到了天亮',
    conditionText: '通关任意一局（兜底结局）',
    check: () => true,   // 兜底：前面所有结局都不满足时命中
    text:
      '终焉梦魇散成了一片雨声。\n'
      + '雨停的时候，走廊第一次显出了长度 —— 它其实很短，走完只要三十秒。\n'
      + '你站在原地，听见门外有三个人在说话，声音很轻，像是怕吵醒谁。\n'
      + '然后你醒了。',
    epilogue:
      '醒来的时候天刚亮，床头灯还亮着。\n'
      + '三个人都坐在各自的床上，谁也没有说话，但谁也没有走。\n'
      + '你坐起来，他们同时看过来 —— 像是等这一刻等了很久。',
    reward: '获得 15000 金币、获得 300 灵魂',
  },
  {
    // ⚠️ end_sleep 必须在**数组末尾**：它是 sorted.find() 全部落空时的最后兜底。
    //    详见上面 end_wake 的注释（那里解释了「rank 顺序」与「数组原序」的区别）。
    id: 'end_sleep', rank: 5, tone: 'dim',
    title: '再睡五分钟', icon: '🛌',
    subtitle: '你赢了这场梦，但一次也没有开口',
    conditionText: '通关，但全程没有与任何室友建立关系、也没有走过理解路线',
    check: (c) => c.maxAffinity < 3 && c.mercyDone === 0,
    text:
      '你把门修得很好。三道铁门一次都没有被撞开，梦魇被清得干干净净。\n'
      + '天亮了，雨停了，钟声也没有再响。\n'
      + '可是门口那三个人一直没有进来 —— 不是进不来，是他们在等你先说话。\n'
      + '而你从头到尾，一次也没有说。',
    epilogue:
      '你把被子往上拉了拉。\n'
      + '「再睡五分钟。」你想。\n'
      + '走廊的灯还亮着。灯下那三个人还站着。他们很有耐心 —— 因为他们等了很久了。',
    reward: null,
  },
];

// ══════════════════════════════════════════════════════════
//  2. 色调（逐字移植）
// ══════════════════════════════════════════════════════════

export const ENDING_TONES = {
  legend: { c1: '#ffd166', c2: '#fbbf24', c3: '#f59e0b', glow: 'rgba(251,191,36,.6)',  label: '完美结局' },
  violet: { c1: '#e9d5ff', c2: '#c084fc', c3: '#a78bfa', glow: 'rgba(192,132,252,.55)', label: '真相结局' },
  cyan:   { c1: '#d5f6ff', c2: '#67e8f9', c3: '#38bdf8', glow: 'rgba(56,189,248,.5)',   label: '理解结局' },
  gold:   { c1: '#ffe9b0', c2: '#fcd34d', c3: '#f59e0b', glow: 'rgba(252,211,77,.5)',   label: '羁绊结局' },
  blue:   { c1: '#dbeafe', c2: '#93c5fd', c3: '#60a5fa', glow: 'rgba(96,165,250,.45)',  label: '基础结局' },
  dim:    { c1: '#cbd5e1', c2: '#94a3b8', c3: '#64748b', glow: 'rgba(148,163,184,.3)',  label: '保留结局' },
};

/** 记忆碎片总数 —— 与 2D 的 DreamFragments.FRAGMENT_DEFS.length 对应。
 *  3D 的碎片由 StoryHost.collectFragment 记进 gb.fragments。
 *  ⚠️ 这个数字是**叙事设计常量**，不是运行时统计；改它要同时改
 *     剧情数据里 collectFragment 的调用次数，否则该结局永远拿不到。 */
export const FRAGMENT_TOTAL = 30;

/** 达成「羁绊」档位所需好感度（与 AFFINITY_TIERS 的 at:10 对齐） */
export const BOND_AT = 10;

// ══════════════════════════════════════════════════════════
//  3. 运行
// ══════════════════════════════════════════════════════════

export function createEndingSystem() {
  /** @type {object|null} 本局判定出的结局 */
  let _current = null;
  /** @type {Set<string>} 跨局已解锁（从 save 的 meta 读） */
  let _unlocked = new Set(loadMeta().endings);

  /**
   * 汇总判定所需的一切游戏状态。
   *
   * @param {object} o
   *   gb       —— 3D 游戏板
   *   progress —— narrative.runtime.progress() 的返回值（可缺省）
   *   affinity —— 3D 目前没有好感度系统；传 { list: [...] } 才会被读
   *   mercy    —— 同上；传 { done: n } 才会被读
   * @returns {object} 判定上下文
   */
  function buildContext({ gb, progress, affinity, mercy } = {}) {
    const ctx = {
      wave: (gb && gb.wave | 0) || 0,
      mode: 'limited',
      maxAffinity: 0, allBonded: false, bondCount: 0,
      mercyDone: 0, fragCollected: 0, fragTotal: FRAGMENT_TOTAL,
      sideDoneAll: false, sideDone: 0, sideTotal: 0,
      loreUnlocked: 0, loreTotal: 0,
    };

    // ── 好感度 ──
    // ⚠️ 3D 还没有好感度系统，所以这段默认不会执行（affinity 为 undefined）。
    //    一旦将来把 AffinitySystem 搬过来，只要把它的 list() 传进来即可，
    //    判定逻辑不用改。这个「留好的口子」本身就是移植说明。
    if (affinity && typeof affinity.list === 'function') {
      const list = affinity.list();
      ctx.bondCount = list.filter((x) => x.value >= 6).length;
      ctx.maxAffinity = list.reduce((a, x) => Math.max(a, x.value), 0);
      ctx.allBonded = list.length > 0 && list.every((x) => x.value >= BOND_AT);
    }
    if (mercy && typeof mercy.done === 'number') ctx.mercyDone = mercy.done;

    // ── 记忆碎片 ──
    const frags = (gb && gb.fragments) || [];
    ctx.fragCollected = frags.length;

    // ── 支线 / 词条（来自叙事运行时）──
    if (progress) {
      if (progress.side) {
        ctx.sideDone = progress.side.done || 0;
        ctx.sideTotal = progress.side.total || 0;
        ctx.sideDoneAll = ctx.sideTotal > 0 && ctx.sideDone >= ctx.sideTotal;
      }
      if (progress.lore) {
        ctx.loreUnlocked = progress.lore.unlocked || 0;
        ctx.loreTotal = progress.lore.total || 0;
      }
    }
    return ctx;
  }

  /**
   * 判定本局结局。通关（第 60 波）时调用。
   *
   * @returns {{def:object, ctx:object, isNew:boolean, tone:object, degraded:string[]}}
   *   degraded —— 列出「因为 3D 还没实现的系统而被读成 0」的项。
   *               调用方应当把它显示出来（或至少 console.warn），
   *               否则表现为「怎么每次都是同一个结局」。
   */
  function evaluate(input = {}) {
    const ctx = buildContext(input);

    // 按 rank 升序取第一个满足条件的（兜底 rank=99 保证一定有结果）
    const sorted = ENDING_DEFS.slice().sort((a, b) => a.rank - b.rank);
    const def = sorted.find((e) => {
      try { return e.check(ctx); } catch (err) { return false; }
    }) || ENDING_DEFS[ENDING_DEFS.length - 1];

    // 缺失系统要显式暴露，不能让「每次都是同一结局」变成一个谜
    const degraded = [];
    if (!input.affinity) degraded.push('好感度（AffinitySystem 未移植 → maxAffinity 恒为 0）');
    if (!input.mercy) degraded.push('理解路线（MercyPath 未移植 → mercyDone 恒为 0）');

    const isNew = !_unlocked.has(def.id);
    if (isNew) { _unlocked.add(def.id); unlockEnding(def.id); }
    _current = def;

    if (degraded.length) {
      console.warn('[ending] 以下系统在 3D 侧尚未实现，本次判定把它们当作 0：\n  · ' + degraded.join('\n  · '));
    }
    return { def, ctx, isNew, tone: ENDING_TONES[def.tone] || ENDING_TONES.dim, degraded };
  }

  /** 本局结局（未判定过则 null） */
  function current() { return _current; }

  function isUnlocked(id) { return _unlocked.has(id); }

  /** 图鉴用：全部结局及解锁状态（隐藏未解锁结局的正文） */
  function list() {
    return ENDING_DEFS.slice().sort((a, b) => a.rank - b.rank).map((e) => ({
      def: e,
      tone: ENDING_TONES[e.tone] || ENDING_TONES.dim,
      unlocked: _unlocked.has(e.id),
    }));
  }

  /** 解锁进度 */
  function progressOf() { return { unlocked: _unlocked.size, total: ENDING_DEFS.length }; }

  /** 开新局时清空「本局结局」，跨局解锁记录保留 */
  function reset() { _current = null; _unlocked = new Set(loadMeta().endings); }

  return { evaluate, current, isUnlocked, list, progress: progressOf, reset, buildContext };
}

export default createEndingSystem;
