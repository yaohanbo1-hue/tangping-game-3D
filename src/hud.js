// ============================================================
//  hud.js —— 2D 覆盖层（DOM 而非 canvas）
// ============================================================
//
// 用 DOM 而不是在 canvas 里画 HUD，理由：
//   · 3D 场景要不断重绘，HUD 的文字没理由跟着重绘；
//   · 文字清晰度、中文字体、无障碍都靠浏览器原生能力；
//   · 2D 版的 HUD 本来就是 canvas 画的（因为整个画面就一张 canvas），
//     3D 版**没有**这个约束，用 DOM 反而更简单。
//
// ── 第 4 步的扩展 ─────────────────────────────────────────
//
// 从「显示几个调试数字」升级成「一个能玩的塔防界面」：
//   · 顶栏：波次 / 金币 / 电力 / 灵魂 / 床位血量
//   · 底部：建造栏（10 种塔 + 发电机等，够钱才亮）
//   · 右侧：选中塔的面板（升级 / 转职二分 / 出售）
//   · 备战期：一个「开始下一波」按钮
//
// ⚠️ HUD 只在**有变化时**改 DOM。塔防一帧要更新 5-10 个数字，
//    连着跑 60 帧就是 600 次 textContent 写入 —— 会明显掉帧。
//    所以下面每个 setter 都做了「值没变就返回」的短路。
// ============================================================

import { BUILD_DEFS } from './rules/constants.js';

/** 建造栏里出现的顺序（前 4 个是基础产能，后面是塔） */
const BAR_ORDER = [
  'miner', 'generator',
  'turret', 'frost', 'laser', 'tesla', 'flame',
  'poison', 'sonic', 'missile', 'gravity', 'prism',
  'repair', 'shield', 'amp', 'bank',
];

export function createHud(root, hooks = {}) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ══ 顶栏 ══
  const bar = el('div', 'hud-bar');

  const title = el('div', 'hud-title');
  title.appendChild(el('span', 'hud-dot'));
  title.appendChild(el('span', null, '躺平发育 · 梦魇防线'));

  const stats = el('div', 'hud-stats');
  const mk = (cls) => { const n = el('span', 'hud-stat ' + cls, '—'); stats.appendChild(n); return n; };
  const stWave = mk('hud-stat--wave');
  const stGold = mk('hud-stat--gold');
  const stPower = mk('hud-stat--power');
  const stSoul = mk('hud-stat--soul');
  const stBed = mk('hud-stat--bed');
  const stFps = mk('hud-stat--fps');

  const controls = el('div', 'hud-controls');
  const btnWave = el('button', 'hud-btn hud-btn--primary', '开始第 1 波');
  const btnToggle = el('button', 'hud-btn', '暂停');
  // 第 5 步：速度（1/2/4×）。塔防的备战期是等待，倍速是刚需。
  const btnSpeed = el('button', 'hud-btn hud-btn--speed', '1×');
  btnSpeed.title = '游戏速度（快捷键 1 / 2 / 3）';
  // 第 5 步：梦境日记 / 设定集
  const btnDiary = el('button', 'hud-btn', '📓 日记');
  btnDiary.title = '梦境日记 · 世界观设定（快捷键 D）';
  // 第 5 步：音效开关（WebAudio 合成，没有外部音频文件）
  const btnSound = el('button', 'hud-btn hud-btn--sound', '🔊');
  btnSound.title = '音效开关（快捷键 M）';
  const btnReset = el('button', 'hud-btn', '重开');
  controls.append(btnWave, btnToggle, btnSpeed, btnDiary, btnSound, btnReset);

  bar.append(title, stats, controls);

  // ══ 建造栏 ══
  const barWrap = el('div', 'hud-buildbar');
  const buildBtns = new Map();
  for (const key of BAR_ORDER) {
    const def = BUILD_DEFS[key];
    if (!def) continue;
    const btn = el('button', 'build-btn');
    btn.dataset.type = key;
    const ic = el('span', 'build-ic', def.icon || '?');
    const nm = el('span', 'build-nm', def.name);
    const cost = el('span', 'build-cost',
      `${def.cost.gold}💰${def.cost.power ? ' ' + def.cost.power + '⚡' : ''}`);
    btn.append(ic, nm, cost);
    btn.title = def.desc || def.name;
    btn.addEventListener('click', () => {
      // 再点一次取消选中（避免「不小心一直在建造模式」）
      const next = buildBtns.get(key).classList.contains('on') ? null : key;
      setBuildType(next);
    });
    buildBtns.set(key, btn);
    barWrap.appendChild(btn);
  }

  // ── 取消建造按钮（移动端补的入口）────────────────────────
  //
  // 桌面靠「再点一次同一个建造按钮」取消，逻辑上是通的，但手机上
  // 这条路径不显眼：手指点在底部一排按钮里，很难意识到「再点一次」等于取消，
  // 而建造模式下点空地又是**建造**而不是取消 —— 于是玩家容易卡在
  // 「不知道自己在建造模式里」的状态。所以给一个显式的 ✕。
  //
  // 只在建造模式出现：平时它没有意义，常驻反而占掉建造栏的宽度
  // （手机上建造栏本来就要横向排 16 个按钮）。
  const btnCancel = el('button', 'build-btn build-btn--cancel', '✕ 取消');
  btnCancel.title = '取消当前建造选择';
  btnCancel.style.display = 'none';
  btnCancel.addEventListener('click', () => setBuildType(null));
  barWrap.appendChild(btnCancel);

  let buildType = null;
  function setBuildType(type) {
    buildType = type;
    for (const [k, b] of buildBtns) b.classList.toggle('on', k === type);
    btnCancel.style.display = type ? '' : 'none';
    if (hooks.onBuildType) hooks.onBuildType(type);
  }

  // ══ 选中面板 ══
  const panel = el('div', 'hud-panel');
  panel.style.display = 'none';
  const pTitle = el('div', 'panel-title', '');
  const pStat = el('div', 'panel-stat', '');
  const pHp = el('div', 'panel-hp', '');
  const pActs = el('div', 'panel-acts');
  const btnUp = el('button', 'hud-btn hud-btn--primary', '升级');
  const btnBrA = el('button', 'hud-btn', '转职 A');
  const btnBrB = el('button', 'hud-btn', '转职 B');
  const btnSell = el('button', 'hud-btn hud-btn--danger', '出售');
  pActs.append(btnUp, btnBrA, btnBrB, btnSell);
  panel.append(pTitle, pStat, pHp, pActs);

  btnUp.addEventListener('click', () => hooks.onUpgrade && hooks.onUpgrade());
  btnBrA.addEventListener('click', () => hooks.onBranch && hooks.onBranch('a'));
  btnBrB.addEventListener('click', () => hooks.onBranch && hooks.onBranch('b'));
  btnSell.addEventListener('click', () => hooks.onSell && hooks.onSell());

  // ══ 提示条 ══
  const toast = el('div', 'hud-toast');
  let toastT = 0;

  // ══ 底部状态行 ══
  const footer = el('div', 'hud-footer');
  const contractLine = el('span', null, '世界坐标契约自检中…');
  const storyLine = el('span', null, '叙事包接入中…');
  storyLine.id = 'story-state';
  // 第 5 步：存档提示。放在 footer 而不是 toast —— 自动存档每 5 秒一次，
  // 用 toast 会刷屏（玩家会觉得"怎么一直在弹东西"）。
  const saveLine = el('span', 'hud-save', '');
  footer.append(contractLine, storyLine, saveLine);

  // panel / toast / buildbar 都是 position:fixed，脱离 #hud 的 flex 流；
  // 真正参与纵向布局的只有 bar、spacer、footer。
  // （buildbar 必须 fixed 才不会落在屏幕正中盖住战场，见 index.html 注释。）
  root.append(bar, el('div', 'hud-spacer'), panel, toast, barWrap, footer);

  // ══ 短路缓存：值为 undefined 保证第一次一定写入 ══
  const last = {};
  const set = (node, key, text) => {
    if (last[key] === text) return;
    last[key] = text;
    node.textContent = text;
  };

  return {
    el, btnWave, btnToggle, btnReset, btnSpeed, btnDiary, btnSound, btnCancel,
    buildBtns, setBuildType,
    get buildType() { return buildType; },

    setWave(w, state, prepLeft) {
      // ⚠️ 规则层的备战期状态名是 **'build'**（core.js:1795），不是 'prep'。
      //    updateWave 里两个名字都接受，所以这里必须都认，否则
      //    HUD 会在备战期一直显示「第 N 波」而不显示倒计时。
      const inPrep = state === 'build' || state === 'prep';
      set(stWave, 'wave', inPrep
        ? (w === 0
          ? `备战中${prepLeft > 0 ? ` ${Math.ceil(prepLeft)}s` : ''}`
          : `第 ${w} 波结束 · 备战 ${Math.ceil(prepLeft)}s`)
        : `第 ${w} 波`);
    },
    setGold(v) { set(stGold, 'gold', `${Math.floor(v)} 💰`); },
    setPower(v) { set(stPower, 'power', `${Math.floor(v)} ⚡`); },
    setSouls(v) { set(stSoul, 'soul', `${Math.floor(v)} 🔮`); },
    setBed(hp, maxHp) { set(stBed, 'bed', `🛏 ${Math.ceil(hp)}/${Math.ceil(maxHp)}`); },
    setFps(v) { set(stFps, 'fps', `${v.toFixed(0)} FPS`); },

    /** 按资源情况点亮/熄灭建造按钮 */
    setAffordable(gb) {
      for (const [k, b] of buildBtns) {
        const def = BUILD_DEFS[k];
        const on = gb.gold >= def.cost.gold && gb.power >= (def.cost.power || 0);
        b.classList.toggle('poor', !on);
      }
    },

    setWaveBtn(text, enabled) {
      set(btnWave, 'wavebtn', text);
      btnWave.disabled = !enabled;
    },

    /** 选中面板：info 来自 towers.selectedInfo()，null = 隐藏 */
    setPanel(info) {
      if (!info) { panel.style.display = 'none'; last.panel = null; return; }
      panel.style.display = '';
      set(pTitle, 'pTitle', `${info.icon} ${info.name} Lv${info.level}/${info.maxLv}${info.branch ? ' · ' + info.branch.toUpperCase() : ''}`);
      set(pStat, 'pStat', info.statText || `伤害 ${Math.round(info.stat.dmg)} · 射程 ${Math.round(info.stat.range)}`);
      set(pHp, 'pHp', `耐久 ${Math.ceil(info.hp)}/${Math.ceil(info.maxHp)}`);
      set(btnUp, 'btnUp', info.level >= info.maxLv ? '已满级' : `升级 ${info.upgrade.gold}💰`);
      btnUp.disabled = info.level >= info.maxLv;
      // 转职按钮只在 6 级且未转职时出现
      const showBr = !!(info.canBranch && info.branches);
      btnBrA.style.display = showBr ? '' : 'none';
      btnBrB.style.display = showBr ? '' : 'none';
      if (showBr) {
        const brA = info.branches.a, brB = info.branches.b;
        btnBrA.textContent = `⬆ ${brA.name} ${brA.cost.gold}💰`;
        btnBrB.textContent = `⬆ ${brB.name} ${brB.cost.gold}💰`;
        btnBrA.title = brA.desc || '';
        btnBrB.title = brB.desc || '';
      }
      set(btnSell, 'btnSell', `出售 +${info.sell}💰`);
    },

    setPaused(p) { set(btnToggle, 'btnToggle', p ? '继续' : '暂停'); },

    // ── 第 5 步新增的四件小事 ──

    /** 速度按钮（1× / 2× / 4×）。同时是「当前倍速」的可见状态。 */
    setSpeed(v) {
      set(btnSpeed, 'btnSpeed', `${v}×`);
      btnSpeed.classList.toggle('on', v !== 1);
    },

    /** 重开按钮的「已武装」状态（防误触：第一次点只是变成红色） */
    setResetArmed(b) {
      btnReset.classList.toggle('armed', !!b);
      set(btnReset, 'btnReset', b ? '再点一次' : '重开');
    },

    /** 音效开关的图标与状态 */
    setSoundOn(on) {
      set(btnSound, 'btnSound', on ? '🔊' : '🔇');
      btnSound.classList.toggle('muted', !on);
    },

    /** 存档提示（空字符串 = 隐藏） */
    setSave(text) {
      set(saveLine, 'save', text || '');
      saveLine.classList.toggle('on', !!text);
    },

    setContract(ok, problems) {
      if (ok) {
        contractLine.textContent = '✅ 世界坐标契约自检通过（网格 / 车道 / 门洞几何一致）';
        contractLine.className = 'ok';
      } else {
        contractLine.textContent = '❌ 契约不一致：' + problems.join('；');
        contractLine.className = 'bad';
      }
    },
    setStory(text, ok) {
      storyLine.textContent = text;
      storyLine.className = ok ? 'ok' : 'bad';
    },

    /** 屏幕中下方的浮动提示（资源不足 / 波次开始 等） */
    notify(text, ms = 1600) {
      toast.textContent = text;
      toast.classList.add('on');
      clearTimeout(toastT);
      toastT = setTimeout(() => toast.classList.remove('on'), ms);
    },
    tickToast(dt) { /* 预留：如果将来改由帧驱动淡出 */ },
  };
}
