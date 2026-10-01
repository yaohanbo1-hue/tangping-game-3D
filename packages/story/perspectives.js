import { BOSS_DIALOG, FOURTH_WALL_EVENTS, WAVE_STORY } from './story.js';
import { getStoryHost, getPacing } from './runtime-ctx.js';

// ============================================================
//  躺平发育：梦魇防线  —  视角插叙（Perspectives）
// ============================================================
//  为什么需要这个文件：
//    整条主线都是第一人称 —— 玩家躺在床上，听见门外三下敲门，
//    然后用六十波去猜那七分钟里发生了什么。
//    但那七分钟里，另外三个人是有视角的，他们看到的东西玩家从来没看过。
//
//    本文件把这些「另一侧的记忆」单独抽出来做成插叙：
//    下楼时楼梯有多滑、值夜室里灯放在哪一格、赵磊讲到第几句停下的、
//    回来时谁先看见床上的人睡着了。
//    它们不解答谜题（谜题由主线解答），但让那七分钟从「空白」变成「有人经历过」。
//
//  与另外几套剧情系统的分工：
//    WAVE_STORY   （story.js）       主线：那七分钟发生了什么（玩家视角）
//    SIDE_STORIES （sidestories.js） 支线：这几个人平时是什么样
//    KEY_EVENTS   （events.js）      事件：这场梦此刻在发生什么
//    PERSPECTIVES （本文件）          插叙：那七分钟里，别人看见了什么
//
//  与其他文件的调用关系：
//    characters.js  —— 上游：视角归属的角色（who）必须存在于档案中
//    letters.js     —— 互补：信件是「写下来的」，插叙是「想起来的」
//    lore.js        —— 下游：部分插叙会解锁对应世界观词条
//    dream.js       —— 触发：DreamEngine.onWaveStart() 调 PerspectiveSystem.checkWave()
//    ui.js          —— 展示：走既有 showStoryDialog()，靠 sceneNote 字段做「视角切换」提示
//    save.js        —— 持久：captureDream() / restoreDream() 存取 _fired
// ============================================================

// ─── 插叙定义 ──────────────────────────────────────────────
// 字段说明：
//   id        稳定标识
//   who       视角归属（剧中人名，用于对话框配色；'旁白' 表示第三人称回放）
//   icon      图标
//   title     插叙标题
//   prefer    期望波次（被占用时自动顺延，与支线/事件共用避让规则）
//   sceneNote 视角切换提示（显示在正文最前面，明确告诉玩家「这不是你的视角」）
//   text      正文
//   choices   可选
//   unlockLore 解锁的世界观词条 id（可选）
const PERSPECTIVE_SCENES = [
  // ══ 那七分钟 · 下楼 ══
  {
    id: 'pov_xia_stairs', who: '林小夏', icon: '🌻', prefer: 6,
    title: '下楼那七分钟 · 小夏',
    sceneNote: '【视角切换 · 那七分钟里，林小夏记得的部分】',
    text:
      '楼梯间的声控灯坏了，只有一楼那盏还亮。\n'
      + '我走在最前面，手扶着绿漆铁管 —— 梅雨天，扶手全是水，滑得抓不住。\n'
      + '赵磊在后面讲笑话，讲到一半停了。我回头看了一眼，他正低头看台阶。\n'
      + '周默在数数。他数得很小声，但我听见了：\n'
      + '「三十一、三十二、三十三……」\n'
      + '我当时想的是：快点拿灯回去，别让他在黑里躺太久。',
    choices: [
      { text: '你走得那么急，是因为我？', effect: '林小夏好感度 +1' },
      { text: '（安静地看完）', effect: '解锁世界观词条' },
    ],
    unlockLore: 'lore_stairwell',
  },
  {
    id: 'pov_zhou_count', who: '周默', icon: '📚', prefer: 12,
    title: '54 级台阶',
    sceneNote: '【视角切换 · 周默的记忆】',
    text:
      '下楼 54 级，上楼 54 级。我数过很多次，这个数字没有变过。\n'
      + '那天晚上我数到第 54 级的时候，心里忽然停了一下 ——\n'
      + '不是数错了，是我想起来：我们出门的时候，屋里是四个人。\n'
      + '我数的是台阶，不是人。但我那一刻特别想回头数一遍人。\n'
      + '我没有回头。这是我后来最常想起的一个细节。',
    choices: [
      { text: '你为什么不回头？', effect: '周默好感度 +1' },
      { text: '你数得没错。', effect: '获得 200 金币' },
    ],
  },
  {
    id: 'pov_lei_joke', who: '赵磊', icon: '😂', prefer: 17,
    title: '讲到一半的那个笑话',
    sceneNote: '【视角切换 · 赵磊的记忆】',
    text:
      '我在楼梯上讲到「为什么闹钟只叫醒三个人」的时候，忽然想不起来后面是什么了。\n'
      + '不是忘了 —— 是我从来没想过后面是什么。\n'
      + '前面那句是我瞎编的，编的时候觉得挺顺，讲到一半才发现它没有结尾。\n'
      + '所以我停了。\n'
      + '小夏回头看了我一眼，我说「没事，忘词了」。\n'
      + '其实我想说的是：我编不下去了，因为我编的那个笑话，说的就是我们。',
    choices: [
      { text: '所以你一直想讲完它。', effect: '赵磊好感度 +1' },
      { text: '编不出来就算了。', effect: '获得 180 金币' },
    ],
  },
  {
    id: 'pov_watchroom', who: '周默', icon: '🗄️', prefer: 24,
    title: '值夜室的第二格',
    sceneNote: '【视角切换 · 周默的记忆】',
    text:
      '灯在铁皮柜第二格。我摸黑打开柜门的时候，手先碰到了第三格。\n'
      + '第三格里是那台录音机。\n'
      + '它的指示灯是亮的 —— 断电的情况下，它是亮的。\n'
      + '我盯着它看了两秒，然后关上了第三格，拿了第二格的灯。\n'
      + '我没有跟任何人说这件事。\n'
      + '……直到现在。',
    choices: [
      { text: '它那时候就在录了。', effect: '解锁世界观词条，周默好感度 +1' },
      { text: '你做得对，先拿灯。', effect: '全队防御 +10%（本波）' },
    ],
    unlockLore: 'lore_recorder',
  },

  // ══ 那七分钟 · 返回 ══
  {
    id: 'pov_return', who: '林小夏', icon: '🔦', prefer: 31,
    title: '回来的那 3 分 20 秒',
    sceneNote: '【视角切换 · 林小夏记得的部分】',
    text:
      '上楼比下楼快。因为我们有灯了。\n'
      + '我举着灯走在前面，光照到三楼走廊的时候，我看见门是关着的。\n'
      + '我心里松了一口气 —— 门关着，说明里面没事。\n'
      + '走到门口，赵磊伸手碰了一下门框，习惯性的，我们每次回来都这样。\n'
      + '「嗒」的一声，很轻。\n'
      + '我当时没在意。后来才知道，你听见的就是这一声。',
    choices: [
      { text: '原来第四声是这个。', effect: '解锁世界观词条，全属性 +6%' },
      { text: '你们只是习惯性碰一下。', effect: '获得 300 金币' },
    ],
    unlockLore: 'lore_fourth_knock',
  },
  {
    id: 'pov_bedside', who: '赵磊', icon: '🛏️', prefer: 35,
    title: '站在床边的那三十秒',
    sceneNote: '【视角切换 · 赵磊的记忆】',
    text:
      '灯放到床头以后，我们三个站在那儿，谁也没说话。\n'
      + '床上的人一动不动，手还攥着被角。小夏伸手想把被角抽出来，抽了两下没抽动。\n'
      + '她就不抽了，改成把灯往你那边挪了半尺。\n'
      + '周默看了一眼表，说「03:14」。\n'
      + '我在心里把那个笑话又讲了一遍 —— 讲到一半还是停住了。\n'
      + '然后我们就各自回床了。整个过程大概三十秒。\n'
      + '我一直以为那三十秒没什么。现在想想，那三十秒里我们三个都在等你睁眼。',
    choices: [
      { text: '我那时候其实醒了一下。', effect: '全属性 +8%，赵磊好感度 +1' },
      { text: '……对不起。', effect: '床铺回复 25%' },
    ],
  },
  {
    id: 'pov_zhou_ledger', who: '周默', icon: '📋', prefer: 41,
    title: '我擦掉的那一笔',
    sceneNote: '【视角切换 · 周默的记忆】',
    text:
      '回到值夜室以后，我打开值夜表准备记录。\n'
      + '第四格我写了三个字，是我自己的名字。\n'
      + '写完之后我盯着看了一会儿，然后把它擦掉了。\n'
      + '不是因为你不在名单里 —— 是因为那一格记的不是「谁在」。\n'
      + '它记的是另一件事，而那件事我不想用我的名字去填。\n'
      + '所以我改成画了一张床。\n'
      + '这张床我画了三年，从来没有画错过。',
    choices: [
      { text: '你一直在替我挡这件事。', effect: '周默好感度 +2，全属性 +8%' },
      { text: '那你现在可以写名字了。', effect: '永久护盾 +300' },
    ],
  },

  // ══ 其他视角 ══
  {
    id: 'pov_chen_duty', who: '旁白', icon: '🔑', prefer: 20,
    title: '楼下值班室 · 03:07',
    sceneNote: '【视角切换 · 第三人称回放】',
    text:
      '老陈在一楼值班室听见楼上有动静。\n'
      + '他抬起头，看了看墙上的钟 —— 03:07。\n'
      + '他没有上楼。因为按规矩，值夜生自己能处理的事，管理员不插手。\n'
      + '他打开自己的日志，翻到中间某一页，用笔尖点了点其中一行。\n'
      + '那一行写的是很多年前的事，格式和今晚一模一样。\n'
      + '他合上本子，把台灯调暗了一格，然后继续坐着等。',
    choices: [
      { text: '他在等什么？', effect: '解锁世界观词条' },
      { text: '（安静地看完）', effect: '获得 250 金币' },
    ],
    unlockLore: 'lore_watchroom',
  },
  {
    id: 'pov_cat', who: '旁白', icon: '🐈', prefer: 37,
    title: '楼梯口的那只猫',
    sceneNote: '【视角切换 · 第三人称回放】',
    text:
      '三点蹲在二楼半的转角，一动不动。\n'
      + '三个人从它身边走过去，谁也没有看见它。\n'
      + '它看着他们下楼，看着他们抱着灯上楼，看着他们停在 307 门口。\n'
      + '赵磊碰门框的那一下，它的耳朵动了一下。\n'
      + '然后它站起来，跟着上了三楼，停在门口。\n'
      + '它没有进去 —— 因为门里的人还没醒，而它知道，猫不该吵醒睡着的人。',
    choices: [
      { text: '它一直在门口。', effect: '床铺回复 20%' },
      { text: '（安静地看完）', effect: '获得 220 金币' },
    ],
  },
  {
    id: 'pov_prev', who: '旁白', icon: '🕰️', prefer: 47,
    title: '很多年前的同一个七分钟',
    sceneNote: '【视角切换 · 第三人称回放 · 时间不明】',
    text:
      '同一间宿舍，同一场雨，同一个 03:07。\n'
      + '三个人下楼取灯，一个人在床上睡着。\n'
      + '不同的是，那一次，床上的人在灯放下的那一刻睁开了眼。\n'
      + '他说了一句「我听见了」。\n'
      + '然后那三个人笑了，笑声把整条走廊都填满了 —— 走廊于是只有三十秒那么长。\n'
      + '……这段记录被老陈写在日志的中间，没有年份。',
    choices: [
      { text: '所以这件事可以有别的结局。', effect: '解锁世界观词条，全属性 +10%' },
      { text: '那一次是谁？', effect: '获得 400 金币' },
    ],
    unlockLore: 'lore_seven',
  },
  {
    id: 'pov_after', who: '你', icon: '🌅', prefer: 53,
    title: '如果我现在睁眼',
    sceneNote: '【视角切换 · 你自己的想象】',
    text:
      '你试着想了一下：如果现在睁眼，会看见什么。\n'
      + '不是梦里的睁眼 —— 是真的醒过来。\n'
      + '天应该刚亮，窗帘缝里有一道白。床头灯还亮着，暖黄色的。\n'
      + '三个人的呼吸声很轻，说明他们还在睡。\n'
      + '你先想好了第一句话该说什么。\n'
      + '然后你发现，这句话你已经在梦里练了六十波。',
    choices: [
      { text: '那就说出来。', effect: '全属性 +15%、免疫控制（本局）' },
      { text: '再想一会儿。', effect: '床铺回满，获得 600 金币' },
    ],
  },
];

// ─── 运行时 ────────────────────────────────────────────────
const PerspectiveSystem = {
  /** @type {Set<string>} 已播出的插叙 id */
  _fired: null,

  init() { if (!this._fired) this._fired = new Set(); },

  /** 与支线/事件共用同一套避让判断 */
  _waveBusy(wave) {
    if (typeof WAVE_STORY !== 'undefined' && WAVE_STORY.some(s => s.wave === wave)) return true;
    if (typeof BOSS_DIALOG !== 'undefined') {
      const keys = Object.keys(BOSS_DIALOG);
      if (keys.some(k => BOSS_DIALOG[k] && BOSS_DIALOG[k].wave === wave)) return true;
    }
    if (typeof FOURTH_WALL_EVENTS !== 'undefined' && FOURTH_WALL_EVENTS.some(e => e.wave === wave)) return true;
    if (typeof TURNING_POINTS !== 'undefined' && TURNING_POINTS.some(t => t.wave === wave)) return true;
    return false;
  },

  /**
   * 波次钩子：由 DreamEngine.onWaveStart() 调用。
   * 与支线一样：**每波最多一段**，按「最早到期优先」排队，插在主线空隙里。
   * @param {number} wave
   * @returns {Array} 本波实际播出的插叙（0 或 1 个）
   */
  checkWave(wave) {
    this.init();
    const fired = [];
    // 插叙优先级最低（在 dream.js 里最后调用），所以最先让位于波次预算
    const queue = PERSPECTIVE_SCENES
      .filter(p => !this._fired.has(p.id) && p.prefer <= wave)
      .sort((a, b) => a.prefer - b.prefer);
    if (!queue.length) return fired;
    if (typeof StoryPacing !== 'undefined' && !StoryPacing.canPlay(wave, wave - queue[0].prefer)) return fired;

    const pick = queue.find(q => q.prefer === wave && !this._waveBusy(wave))
      || queue.find(q => !this._waveBusy(wave))
      || queue[0];

    this._fire(pick, wave);
    if (typeof StoryPacing !== 'undefined') StoryPacing.take(wave);
    fired.push(pick);
    return fired;
  },

  _fire(sc, wave) {
    this._fired.add(sc.id);
    // sceneNote 拼在正文最前面 —— 明确告诉玩家「这不是你的视角」，
    // 否则玩家会以为是自己错过了什么，反而更困惑。
    const body = (sc.sceneNote ? sc.sceneNote + '\n\n' : '') + sc.text;
    // 走宿主接口（见 host.js），不要用全局探测：ESM 里恒失效、且是静默的。
    const host = getStoryHost();
    if (sc.unlockLore) {
      try { getLoreCodex().unlock(sc.unlockLore); } catch (e) {}
    }
    try {
      host.showDialog({
        wave: wave, speaker: sc.who, text: body, choices: sc.choices, kind: 'perspective',
      });
    } catch (e) { console.warn('[Perspective] dialog:', e); }
    try { host.diary('story', '视角插叙「' + sc.title + '」'); } catch (e) {}
  },

  list() {
    this.init();
    return PERSPECTIVE_SCENES.map(p => ({ def: p, fired: this._fired.has(p.id) }));
  },

  progress() {
    this.init();
    return { fired: PERSPECTIVE_SCENES.filter(p => this._fired.has(p.id)).length, total: PERSPECTIVE_SCENES.length };
  },

  snapshot() { this.init(); return { fired: Array.from(this._fired) }; },

  restore(snap) {
    this.init();
    if (snap && Array.isArray(snap.fired)) snap.fired.forEach(x => this._fired.add(x));
  },

  reset() { this._fired = new Set(); },
};

// ── ESM 导出（构建脚本自动追加，勿手改这段）──
export { PERSPECTIVE_SCENES, PerspectiveSystem };
