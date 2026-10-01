// ============================================================
//  chapters.js —— 章节系统（Chapters）· ESM 版
// ============================================================
//
// 由 2D 引擎根目录的 chapters.js 移植而来，**数据一字未改**，
// 只做了一件事：把「靠全局作用域取依赖」改成「显式 import / 注入」。
//
// 三处改动（其余全部逐字保留）：
//   1. STORY_ARCS 从全局探测 → 从 ./story.js import（数据在同一个包里）
//   2. LoreCodex / AffinitySystem 从全局探测 → 走 runtime-ctx（避免循环依赖）
//   3. StoryPacing 抽到 ./pacing.js（2D/3D 共用一份预算），本文件不再定义
//
//  与其他文件的调用关系：
//    story.js   —— 上游：STORY_ARCS 提供五幕骨架
//    lore.js    —— 引用：每章声明 loreRefs，回顾里统计解锁条目数
//    runtime.js —— 触发：波次管线第一站（幕卡必须先于台词出现）
//    存档       —— 持久：snapshot() / restore()
// ============================================================

import { STORY_ARCS } from './story.js';
import { getStoryHost } from './host.js';
import { getLoreCodex, getAffinitySystem } from './runtime-ctx.js';

// ─── 1. 五幕骨架 ───────────────────────────────────────────
// 直接由 story.js 的 STORY_ARCS 派生，保证「幕名 / 波次范围 / 核心疑问」只有一处定义。
// 若 STORY_ARCS 为空（不合约），退回一份等价的内联副本。

const CHAPTER_ACTS = (function () {
  const fallback = [
    { id: 'night-watch',    title: '床边的第四声', waves: [1, 10],  question: '门外三声之后，床边那一声是谁敲的？' },
    { id: 'the-record',     title: '倒放的值夜表', waves: [11, 20], question: '记录为什么先写了「回来」，再写「出发」？' },
    { id: 'the-empty-place',title: '空位属于谁',   waves: [21, 35], question: '照片里的空位，真的是少了一个人吗？' },
    { id: 'the-lamp',       title: '灯一直亮着',   waves: [36, 50], question: '朋友回来以后，为什么梦还在等？' },
    { id: 'the-reply',      title: '听完那条语音', waves: [51, 60], question: '这一次，你愿意亲口回答吗？' },
  ];
  const src = (Array.isArray(STORY_ARCS) && STORY_ARCS.length)
    ? STORY_ARCS : fallback;
  return src.map((a, i) => ({
    id: a.id, index: i + 1, title: a.title, waves: a.waves, question: a.question,
    label: ['第一幕', '第二幕', '第三幕', '第四幕', '第五幕'][i] || ('第 ' + (i + 1) + ' 幕'),
  }));
})();

// ─── 2. 子章节 ─────────────────────────────────────────────
// ⚠️ 与 story.js 的 STORY_ARCS / WAVE_STORY 严格对齐（信息释放阶梯见 story.js 顶部）。
//    幕边界为 12 / 25 / 40 / 50，真相落在第四幕末尾（第 49-50 波）。
//    recap 会显示在日记面板与结算回顾里，所以同样受信息阶梯约束：
//    前三幕的 recap 不得写出第四幕的答案。
const CHAPTER_DEFS = [
  // ══ 第一幕：门外有三个人（1-12）══
  {
    id: 'ch_1_1', act: 'night-watch', title: '停电的三分钟', waves: [1, 4], sceneId: 'wake_0307',
    goal: '建起第一台矿机与发电机，撑过最初的三波。',
    summary: '你在 03:07 醒来，门外三下敲门，床头又响了一声。',
    recap: '梦从停电那一秒开始。\n'
         + '门外三下是真实的敲门 —— 间隔一样，力度一样，像是用手掌拍的。\n'
         + '然后床头响了一声「嗒」，很轻，位置不在门上，在屋里。\n'
         + '屋里三个人都回头看向门。他们脸上的表情不是害怕，是困惑。',
    loreRefs: ['lore_door3', 'lore_develop', 'lore_three'],
  },
  {
    id: 'ch_1_2', act: 'night-watch', title: '刻痕与日期', waves: [5, 8],
    goal: '看清床头墙上那排刻痕，弄清它们记的是什么。',
    summary: '墙上的刻痕不是日历，是某种流程的记号。',
    recap: '三道短痕，隔开一段空白，再添一道长痕 —— 一组一组，刻得很整齐。\n'
         + '前面每一组都是完整的。最后一组只有三道短痕，后面那一笔没有人刻。\n'
         + '刻痕最深的那几组很旧，最后一组很浅，像是怕吵醒谁。',
    loreRefs: ['lore_bedside', 'lore_soul', 'lore_fragment'],
  },
  {
    id: 'ch_1_3', act: 'night-watch', title: '被雨泡过的记录', waves: [9, 12], sceneId: 'first_return',
    goal: '读懂值夜表最后一页能看清的那部分。',
    summary: '值夜表被雨水泡过，只剩一行能看清，总人数那一格是空的。',
    recap: '「03:07，三人下楼取灯；床上留一人。」\n'
         + '下面那一行完全洇开了。本该写总人数的那一格是空的 —— 不是没写，是看不清。\n'
         + '周默说这一行后面本来应该有字的。他把纸收起来了，说等干了再看。',
    loreRefs: ['lore_watchroom', 'lore_ledger', 'lore_shadow_lore'],
  },

  // ══ 第二幕：值夜表上的空位（13-25）══
  {
    id: 'ch_2_1', act: 'the-record', title: '四个圈', waves: [13, 17],
    goal: '弄清值夜表边上那四个圈是什么意思。',
    summary: '周默画了四个圈：三个有名字，第四个只画了一张床。',
    recap: '三个圈写了名字 —— 他、小夏、赵磊。最后一个圈没有名字，只画了一张床。\n'
         + '赵磊问他为什么不写第四个人的名字。他说：「那个人在睡觉，写名字就像把他叫醒。」\n'
         + '这句话当时听着很对。现在再想，它回答的不是「为什么不写」，是「为什么不叫」。',
    loreRefs: ['lore_reverse', 'lore_stairwell', 'lore_fourth_person'],
  },
  {
    id: 'ch_2_2', act: 'the-record', title: '折起来的第四格', waves: [18, 21],
    goal: '找到折在床垫底下的那张便条。',
    summary: '值夜表第四格不是被擦掉的，是折起来的一张便条。',
    recap: '便条露出的半句话是：「他睡着了，灯留着。」\n'
         + '小夏没敢把它抽出来 —— 因为一旦抽出来，就得回答「他」是谁。\n'
         + '这间宿舍，从大一开始登记的就是三个人。',
    loreRefs: ['lore_note', 'lore_echo_omen', 'lore_deepdream'],
  },
  {
    id: 'ch_2_3', act: 'the-record', title: '镜子前的人数', waves: [22, 25],
    goal: '在镜面梦魇的反弹伤害下活到第二幕结束。',
    summary: '周默去镜子前核对人数，留下一张被涂黑的纸条。',
    recap: '纸条上写着「别数走廊里的影子，数值夜表上的名字」。\n'
         + '背面有一行被划掉的补记，只看清三个字：「床上……」——后面被涂黑了。\n'
         + '梦魇在这一幕末尾问了一句：你们四个人里，有一个从头到尾没有出过声。',
    loreRefs: ['lore_carving', 'lore_band'],
  },

  // ══ 第三幕：镜子里的第四个人（26-40）══
  {
    id: 'ch_3_1', act: 'the-empty-place', title: '合照上的半张脸', waves: [26, 31],
    goal: '把三个人各自藏着的半句话拼起来。',
    summary: '合照上的第四个位置不是空的，是被被子盖住了半张脸。',
    recap: '赵磊盯着那张照片看了很久，忽然发现自己认不出那半张脸。\n'
         + '明明是自己宿舍的照片 —— 他怎么会认不出？\n'
         + '他把照片翻过去了。小夏没有问为什么。',
    loreRefs: ['lore_mimic_omen', 'lore_photo'],
  },
  {
    id: 'ch_3_2', act: 'the-empty-place', title: '只有前半段的语音', waves: [32, 36], sceneId: 'ledger_four',
    goal: '听完录音能听到的那一部分。',
    summary: '录音只有前半段：雨声、脚步、拧门把手，然后就没有了。',
    recap: '开头是周默：「停电了，我们去拿应急灯，很快回来。」\n'
         + '接下来七分钟，只有雨声和脚步。后半段是空的 —— 不是损坏，是本来就还没录完。\n'
         + '小夏说这句话的时候一直看着你，像是在等你先说什么。',
    loreRefs: ['lore_tape', 'lore_gap'],
  },
  {
    id: 'ch_3_3', act: 'the-empty-place', title: '她没说出口的那句话', waves: [37, 40], sceneId: 'mirror_bed',
    goal: '面对镜子里那道一直不消失的影子。',
    summary: '镜子里站着三个人、躺着一个；小夏把话咽了回去。',
    recap: '镜子换了几个角度，那道影子都在。周默说他不知道该怎么记 —— '
         + '写「床上有一人」，第四格就有人了。\n'
         + '小夏说了一半的话停在半路：「我们回来的时候——」\n'
         + '然后她改口了：「这句话不该由我来说。你自己去值夜表上找吧。」',
    loreRefs: ['lore_fourth_person', 'lore_shadow_lore'],
  },

  // ══ 第四幕：那七分钟（41-50）══ 真相在本幕末尾落定
  {
    id: 'ch_4_1', act: 'the-seven', title: '时间戳', waves: [41, 45],
    goal: '把那七分钟按录音的时间戳重新排一遍。',
    summary: '03:07 停电，03:14 回来，中间只有雨声和脚步 —— 没有别的声音。',
    recap: '周默这次不靠记忆，靠录音的时间戳：03:07 下楼，03:14 回来，中间七分钟。\n'
         + '雨声、脚步、拧门把手、灯放下的磕碰。就这些。\n'
         + '赵磊在录音里说了一句「到了，别叫醒他」—— 那句话压在磁带最底下，要倒着放才听得见。',
    loreRefs: ['lore_seven', 'lore_fourth_knock'],
  },
  {
    id: 'ch_4_2', act: 'the-seven', title: '烘干的值夜表', waves: [46, 48], sceneId: 'ledger_four',
    goal: '把值夜表那一页烘干，看清被水遮住的两行。',
    summary: '水渍褪下去以后，「床边：三人，已返回」「总人数：四人」终于看得清了。',
    recap: '「床边：三人，已返回。」\n'
         + '「总人数：四人。」\n'
         + '这间宿舍从大一开始就是四人间。第四张床被抬走了 —— 但人没有。\n'
         + '你守了四十七波的那扇门，从来没有关住任何东西。',
    loreRefs: ['lore_ledger', 'lore_tape', 'lore_bed_law'],
  },
  {
    id: 'ch_4_3', act: 'the-seven', title: '四人已齐', waves: [49, 50],
    goal: '接受真相，并决定要不要听完录音的最后一句。',
    summary: '第四个人从来没有离开过这间屋子 —— 他一直躺在那张床上。',
    recap: '真相没有戏剧性：那晚你睡着了。他们没有叫醒你，只是把灯放下，站在床边看了一会儿。\n'
         + '门外那三下、床头那一声，都是梦把七分钟拉长以后自己长出来的。\n'
         + '现在剩下的唯一一件事 —— 那段录音的最后一句，你要不要听。',
    loreRefs: ['lore_gap', 'lore_echo_omen'],
  },

  // ══ 第五幕：亲口回答（51-60）══
  {
    id: 'ch_5_1', act: 'the-reply', title: '录音的后半段', waves: [51, 56], sceneId: 'message_0307',
    goal: '把 03:07 到 03:14 完整听一遍。',
    summary: '你怕的不是坏消息，是这段声音一旦结束就再也不能拖延回答。',
    recap: '录音总长 7 分 12 秒。前面是雨声和脚步，最后是赵磊那句「灯拿回来了，我们都到了」。\n'
         + '那七分钟没有吞掉任何人。是梦把等待拉得太长，让你以为门外一直空着。',
    loreRefs: ['lore_tape', 'lore_gap', 'lore_fourthwall_omen'],
  },
  {
    id: 'ch_5_2', act: 'the-reply', title: '停止键', waves: [57, 58],
    goal: '听完最后一声「嗒」。',
    summary: '播放器走完七分钟，赵磊按下停止键。',
    recap: '噪声里似乎还夹着一句很轻的声音。像你，也像梦替你回答。\n'
         + '那是这场梦第一次出现「你自己的声音」。',
    loreRefs: ['lore_recorder'],
  },
  {
    id: 'ch_5_3', act: 'the-reply', title: '亲口回答', waves: [59, 60], sceneId: 'morning_door',
    goal: '在终焉梦魇面前，亲口说出第一句话。',
    summary: '记录最后一行终于显出来：「床边三人，床上一人 —— 四人已齐。」',
    recap: '小夏没有催你开门，只轻声问：「这次，你愿意自己回答我们吗？」\n'
         + '这场梦的通关条件从来不是守住第 60 波。\n'
         + '是你愿意让录音播完，然后自己开口。',
    loreRefs: ['lore_echo_omen', 'lore_lamp', 'lore_fourth_person'],
  },
];

// ─── 4. 运行时：章节追踪 ───────────────────────────────────
const ChapterSystem = {
  /** @type {Set<string>} 已经播过幕卡的幕 id（防止重复演出） */
  _firedActs: null,
  /** @type {Set<string>} 已经到过的子章节 id（存档用） */
  _reached: null,
  /** 当前子章节 id */
  _current: null,

  init() {
    if (!this._firedActs) this._firedActs = new Set();
    if (!this._reached) this._reached = new Set();
  },

  /** 根据波次取当前子章节定义 */
  atWave(wave) {
    return CHAPTER_DEFS.find(c => wave >= c.waves[0] && wave <= c.waves[1]) || null;
  },

  /** 根据波次取所属幕定义 */
  actAtWave(wave) {
    return CHAPTER_ACTS.find(a => wave >= a.waves[0] && wave <= a.waves[1]) || null;
  },

  /** 当前子章节定义 */
  current() {
    this.init();
    if (this._current) {
      const c = CHAPTER_DEFS.find(x => x.id === this._current);
      if (c) return c;
    }
    // 兜底：按宿主当前波次直接推导。
    // 场景：刚读档完成、或刚开局还没跑过 checkWave —— 此时 _current 是空的，
    // 但宿主已经有波次了，日记面板顶部的章节条不该因此整条消失。
    const w = getStoryHost().getFlag('wave');
    if (typeof w === 'number' && w > 0) return this.atWave(w);
    return null;
  },

  /**
   * 波次钩子：由 runtime.js 的波次管线调用（**管线第一站**）。
   * 负责推进当前章节、必要时播幕卡。
   * @param {number} wave - 当前波次
   * @returns {object|null} 若进入新章节，返回该章节定义
   */
  checkWave(wave) {
    this.init();
    const ch = this.atWave(wave);
    if (!ch) return null;
    const host = getStoryHost();

    // 幕切换演出（每幕只演一次，且不在第 1 波演 —— 开局已经够热闹了）
    const act = this.actAtWave(wave);
    if (act && wave > 1 && !this._firedActs.has(act.id)) {
      this._firedActs.add(act.id);
      host.actCard(act.label + ' · ' + act.title, act.title, act.question);
    }

    if (this._current === ch.id) return null;   // 同一章内，不重复提示

    const isNew = !this._reached.has(ch.id);
    this._current = ch.id;
    this._reached.add(ch.id);

    if (isNew) {
      host.diary('story', '【' + ch.title + '】' + ch.summary);
      host.toast('📖 章节推进 · ' + ch.title, ch.goal, 'gold', 6);
    }
    return isNew ? ch : null;
  },

  /** 进度：已到达子章节数 / 总数 */
  progress() {
    this.init();
    return { reached: this._reached.size, total: CHAPTER_DEFS.length };
  },

  /** 当前幕的序号（1-5），用于 HUD/面板显示 */
  actIndex(wave) {
    const a = this.actAtWave(wave);
    return a ? a.index : 0;
  },

  /**
   * 章节回顾文本 —— 供日记面板/结算界面读取。
   * 会额外统计该章解锁的世界观词条数与角色羁绊数，让「回顾」有内容可看。
   * @param {string} [id] - 章节 id；不传则取当前章节
   */
  recap(id) {
    this.init();
    const ch = id ? CHAPTER_DEFS.find(c => c.id === id) : this.current();
    if (!ch) return null;
    const act = CHAPTER_ACTS.find(a => a.id === ch.act);
    let loreGot = 0, loreTotal = 0;
    const codex = getLoreCodex();
    if (codex && Array.isArray(ch.loreRefs)) {
      loreTotal = ch.loreRefs.length;
      loreGot = ch.loreRefs.filter(x => codex.isUnlocked(x)).length;
    }
    const affinity = getAffinitySystem();
    return {
      chapter: ch, act,
      reached: this._reached.has(ch.id),
      recap: ch.recap,
      loreGot, loreTotal,
      bonds: affinity ? affinity.bondCount() : 0,
    };
  },

  /** 存档用 */
  snapshot() {
    this.init();
    return { reached: Array.from(this._reached), firedActs: Array.from(this._firedActs), current: this._current };
  },

  /** 存档用 */
  restore(snap) {
    this.init();
    if (!snap) return;
    if (Array.isArray(snap.reached)) snap.reached.forEach(x => this._reached.add(x));
    if (Array.isArray(snap.firedActs)) snap.firedActs.forEach(x => this._firedActs.add(x));
    if (snap.current) this._current = snap.current;
  },

  /** 开新局 */
  reset() { this._firedActs = new Set(); this._reached = new Set(); this._current = null; },
};

// ── ESM 导出 ──
export { CHAPTER_ACTS, CHAPTER_DEFS, ChapterSystem };
