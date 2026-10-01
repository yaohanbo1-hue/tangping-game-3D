// ============================================================
//  story-ui.js —— 剧情 UI 层（对话框 / 幕卡 / toast / 日记 / 结局）
// ============================================================
//
// 为什么单独一个文件（而不是塞进 hud.js）：
//
//   hud.js 管的是**战斗 HUD** —— 顶栏数字、建造栏、选中面板。
//   这些是「一直在那儿、每帧可能变」的东西。
//
//   story-ui.js 管的是**叙事演出** —— 对话框、幕卡、结局画面。
//   这些是「弹出来、要求玩家读、然后消失」的东西，有自己的节奏和生命周期：
//     · 对话会**暂停游戏**（塔防里玩家在读字时不该被打死）
//     · 幕卡是纯演出，不需要交互，但需要自己的入场/退场动画
//     · 结局画面是一次性的终局
//
//   两套东西的打断/恢复语义完全不同，混在一个文件里迟早会互相干扰
//   （比如「暂停中又弹出建造栏 hover」）。所以分开。
//
// ── 与叙事包的关系 ────────────────────────────────────────
//
//   本文件是 StoryHost 接口的**3D 实现**。叙事包里的运行时
//   （章节/支线/事件/插叙）只调 host.showDialog(...)，不知道
//   下面到底是 2D canvas 还是 3D DOM。这样两边行为必然一致。
//
// ── 选项与奖励 ────────────────────────────────────────────
//
//   剧情里很多节点带 choices,每个选项有 `effect` 人类可读文案
//   （如「周默好感度 +1，解锁世界观词条」）。3D 侧的处理：
//     · 显示选项按钮 + effect 文案（让玩家知道代价）
//     · 记录选择（applyEffect 走宿主解析）
//   解析人类可读文案是**有意的**：900 行剧情数据是策划写的自由文本，
//   强行结构化会要求全部重写，收益远小于成本。
// ============================================================

// ── 剧情镜头（视频）────────────────────────────────────────
//
//   六条镜头视频按 sceneId 挂在对应波次的对话上，显示在对话框上方。
//   关键约定：**视频是增强，不是依赖**。
//     · 素材缺失 / 解码失败 / 浏览器不支持 → 整层不出现，文字照常
//     · 只有 poster 没有 video 也是有效的（静态画面）
//   所以 `STORY_VIDEO_SLOTS` 里全是 null 时，这个文件的行为和以前完全一样。
//
//   相对路径的坑：2D 版把路径写成 `assets/story/xxx.mp4`（相对 index.html）。
//   3D 工程走 Vite，页面在 dev 下是根路径、产物是 `./`，把外置素材
//   放进 `public/` 后用 `assets/story/xxx.mp4` 会被 Vite 原样搬到产物根目录，
//   两种形态都能命中。见下方 resolveMediaUrl()。
// ============================================================

import { STORY_VIDEO_SLOTS } from './story.js';

/** 素材基准路径。Vite 的 BASE_URL 在 dev 下是 '/'，产物下是 './'。 */
function mediaBase() {
  const b = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || './';
  return b.endsWith('/') ? b : b + '/';
}

/**
 * 把 slot 里的路径解析成当前形态下可用的 URL。
 *
 * 三条规则（顺序重要）：
 *   1. 已经是绝对 URL / data: / blob: → 原样返回
 *   2. 以 '/' 开头 → 去掉开头的 '/' 再接 BASE_URL（避免产物下双斜杠）
 *   3. 其余相对路径 → 直接拼 BASE_URL
 */
function resolveMediaUrl(p) {
  if (typeof p !== 'string') return '';
  const s = p.trim();
  if (!s) return '';
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  const base = mediaBase();
  return base + s.replace(/^\.?\//, '');
}

/**
 * @param {HTMLElement} root  HUD 根节点
 * @param {object} hooks
 *   onChoice(choice, ctx)  —— 玩家选了某个选项
 *   onDialogOpen()         —— 对话开始（宿主可以据此暂停游戏）
 *   onDialogClose()        —— 对话结束（恢复）
 *   videoSlots             —— 覆盖内置 STORY_VIDEO_SLOTS（测试/定制用）
 */
export function createStoryUI(root, hooks = {}) {
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // ══ 幕卡（第一幕 · 床边的第四声）══
  const actCard = el('div', 'su-act');
  const actLabel = el('div', 'su-act-label');
  const actTitle = el('div', 'su-act-title');
  const actQ = el('div', 'su-act-q');
  actCard.append(actLabel, actTitle, actQ);

  // ══ 对话框 ══
  const dlgWrap = el('div', 'su-dialog');
  const dlgBox = el('div', 'su-box');
  const dlgKind = el('div', 'su-kind');
  const dlgWho = el('div', 'su-who');
  const dlgText = el('div', 'su-text');
  const dlgChoices = el('div', 'su-choices');
  const dlgHint = el('div', 'su-hint', '点击继续 ▾');
  dlgBox.append(dlgKind, dlgWho, dlgText, dlgChoices, dlgHint);
  dlgWrap.appendChild(dlgBox);

  // ══ 剧情镜头层（视频 / 首帧静帧）══
  //
  // 六条视频按镜头编号挂在对话框上方。素材缺失时整层不出现，
  // 文字剧情照常 —— 这是刻意的设计：视频是增强，不是依赖。
  //
  // 用**双层交叉淡入**而不是单个 <video> 改 src：
  //   1. 换 src 会先黑一帧（解码器重新初始化），在慢镜头上很显眼；
  //   2. 两层各持有自己的 <video>，新镜头播起来之后才淡出旧镜头，
  //      中间永远有一帧画面在，不会闪黑。
  const mediaWrap = el('div', 'su-media');
  const mediaStage = el('div', 'su-media-stage');
  const mediaCap = el('div', 'su-media-cap');
  mediaWrap.append(mediaStage, mediaCap);
  // 两层交替使用：A 显示时，B 去预载下一个镜头
  const mediaLayers = [el('div', 'su-media-layer'), el('div', 'su-media-layer')];
  mediaLayers.forEach((l) => mediaStage.appendChild(l));
  let mediaTop = 0;              // 当前"上面那层"的下标
  let mediaSlotId = null;        // 当前正在演的镜头编号，避免同镜头重复起播
  let mediaFit = 'contain';      // 显示模式（见 setMediaFit）
  // ── 世代号：解决"过期的异步续体改动当前状态"这一类竞态 ──
  //
  // 镜头层有三个异步尾巴：fillLayer 的 `playing`/`decode` 回调、它的 2500ms
  // 兜底定时器、以及 hideMedia 的 700ms 清理定时器。它们都可能在**下一次
  // 调用之后**才落地。若不设防，就会出现：
  //   · hideMedia 的清理定时器把 showMedia 刚填好的层一起清掉 → 黑屏
  //     （实测：mediaScene 报 morning_door、层 opacity=1，但两层都 empty）
  //   · 旧 showMedia 的 .then() 迟到 → 翻转 mediaTop、改别人的层
  //     → 层记账永久错位，之后每次过渡都错
  // 每次状态变更自增 mediaGen；异步续体落地时先对号，过期就放弃。
  let mediaGen = 0;

  // ══════════════════════════════════════════════════════════
  //  剧情镜头：播放 / 交叉淡入
  // ══════════════════════════════════════════════════════════

  /** 取某个 sceneId 的 slot（已解析过 URL）。没有可用素材则返回 null。 */
  function slotFor(sceneId) {
    if (!sceneId) return null;
    const table = hooks.videoSlots || STORY_VIDEO_SLOTS;
    const raw = table && table[sceneId];
    if (!raw) return null;
    const video = resolveMediaUrl(raw.video);
    const poster = resolveMediaUrl(raw.poster);
    if (!video && !poster) return null;          // 空槽：整层不出现
    return { id: sceneId, video, poster, title: raw.title || '' };
  }

  /** 清空某一层（停播 + 撤 src，避免它在后台继续解码吃 CPU）。 */
  function clearLayer(layer) {
    const v = layer.querySelector('video');
    if (v) {
      v.onerror = null;
      v.onplaying = null;
      try { v.pause(); } catch { /* 忽略：未起播时 pause 可能抛 */ }
      v.removeAttribute('src');
      try { v.load(); } catch { /* 同上 */ }
    }
    layer.replaceChildren();
    layer.classList.remove('on');
  }

  /**
   * 给一层装上新的镜头内容。
   *
   * 返回一个 Promise，在**画面可以显示**时 resolve：
   *   · 有 video：等到 `playing`（真正出画）或超时兜底
   *   · 只有 poster：图片 decode 后
   * 这样交叉淡入才能"等新画面就绪再淡出旧的"，中间不会闪黑。
   */
  function fillLayer(layer, slot) {
    clearLayer(layer);
    // 关键：装内容之前先确保这一层是**全透明**的。
    // 否则上一次用完留下的 opacity:1 会让"还没装好东西的空层"盖在上面，
    // 表现为换镜头时闪一下黑。
    layer.style.opacity = '0';
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };

      let img = null;
      if (slot.poster) {
        img = el('img', 'su-media-img');
        img.alt = (slot.title || '剧情镜头') + ' 首帧';
        img.decoding = 'async';
        img.onerror = () => { img.hidden = true; };
        img.src = slot.poster;
        layer.appendChild(img);
        if (img.decode) img.decode().then(finish).catch(() => {});
        img.onload = finish;
      }

      if (!slot.video) {
        // 只有静帧：等图片（或立刻）
        if (!slot.poster) finish();
        setTimeout(finish, 1200);   // 兜底，避免 decode 永挂
        return;
      }

      const v = el('video', 'su-media-video');
      v.playsInline = true;
      v.muted = true;               // 自动播放的前提（剧情文字已承担叙事）
      v.loop = true;                // 短视频循环，玩家读多久都不会停成黑屏
      v.preload = 'auto';
      v.setAttribute('muted', '');
      v.setAttribute('aria-label', slot.title || '剧情镜头');
      if (slot.poster) v.poster = slot.poster;
      // 视频出画后才算就绪；失败了就退回静帧（poster 还在层里）
      v.onplaying = finish;
      v.onerror = () => {
        v.hidden = true;
        finish();                   // 视频挂了但有 poster → 静帧顶上
      };
      v.src = slot.video;
      layer.appendChild(v);         // 必须在设 src 之后 append 才触发加载
      const p = v.play();
      if (p && p.catch) p.catch(() => { /* 真正出画由 onplaying 兜 */ });
      setTimeout(finish, 2500);     // 兜底：网络慢 / 自动播放被拒
    });
  }

  /**
   * 切换到某个镜头。同镜头重复调用是幂等的（不会重播、不会闪）。
   *
   * @param {string} sceneId
   * @param {object} [opts]
   *   opts.caption  覆盖说明文字
   */
  function showMedia(sceneId, opts = {}) {
    const slot = slotFor(sceneId);
    if (!slot) { hideMedia(); return Promise.resolve(false); }
    if (slot.id === mediaSlotId && mediaWrap.classList.contains('on')) {
      return Promise.resolve(true);            // 已经在演这个镜头
    }
    const gen = ++mediaGen;                    // 认领这一世代
    mediaSlotId = slot.id;
    mediaCap.textContent = opts.caption !== undefined ? opts.caption : (slot.title || '');
    mediaCap.style.display = mediaCap.textContent ? '' : 'none';

    const incoming = mediaLayers[1 - mediaTop];
    const outgoing = mediaLayers[mediaTop];
    // 先把新层淡入，等它出画后再让旧层退出 → 全程有画面
    return fillLayer(incoming, slot).then(() => {
      // ⚠️ 先对世代号。期间若有更新的 showMedia / hideMedia / reset，
      //    这次调用已经作废，绝不能再去动层和 mediaTop。
      if (gen !== mediaGen) return false;
      mediaWrap.classList.add('on');
      incoming.style.opacity = '1';
      outgoing.style.opacity = '0';
      mediaTop = 1 - mediaTop;   // 翻转：incoming 成为"当前层"
      // ⚠️ 清理的必须是 **outgoing 这个变量**，不能在超时回调里再算一次
      //    `mediaLayers[1 - mediaTop]` —— 那时 mediaTop 已经翻转，算出来的
      //    是刚填好的 incoming，会把新画面一起清掉（表现为"过渡结束后黑屏"）。
      //    这个 bug 真的发生过：验收里 final 两层都是 empty。
      const stale = outgoing;
      setTimeout(() => {
        if (gen !== mediaGen) return;              // 过期：别碰现在的层
        if (stale !== mediaLayers[mediaTop]) clearLayer(stale);
      }, 700);
      return true;
    });
  }

  /** 收起镜头层（停播两层）。 */
  function hideMedia() {
    const gen = ++mediaGen;    // 作废所有在飞的 showMedia 续体
    mediaSlotId = null;
    mediaWrap.classList.remove('on');
    // 两层一起淡出，然后把 mediaTop 归零 —— 下次 showMedia 从干净状态开始。
    // ⚠️ 清理要**对世代号**：这 700ms 内若来了新镜头，它已经填好并开始淡入，
    //    此时再无条件清两层会把新画面一起抹掉（实测就是"层可见但全空"的黑屏）。
    const stale = mediaLayers.slice();
    mediaLayers.forEach((l) => { l.style.opacity = '0'; });
    mediaTop = 0;
    setTimeout(() => { if (gen === mediaGen) stale.forEach(clearLayer); }, 700);
  }

  /** 显示模式：'contain'（完整画面，默认）/ 'cover'（铺满，裁边）。 */
  function setMediaFit(mode) {
    mediaFit = mode === 'cover' ? 'cover' : 'contain';
    mediaWrap.dataset.fit = mediaFit;
    mediaLayers.forEach((l) => {
      const v = l.querySelector('video');
      const i = l.querySelector('img');
      if (v) v.style.objectFit = mediaFit;
      if (i) i.style.objectFit = mediaFit;
    });
  }
  mediaWrap.dataset.fit = mediaFit;

  // ══ 演出用 toast（章节推进 / 设定解锁 / 短事件）══
  const toastWrap = el('div', 'su-toasts');

  // ══ 日记 / 设定集面板 ══
  const panel = el('div', 'su-panel');
  panel.style.display = 'none';
  const panelHead = el('div', 'su-panel-head');
  const panelTitle = el('div', 'su-panel-title', '梦境日记');
  const panelClose = el('button', 'su-panel-close', '✕');
  panelHead.append(panelTitle, panelClose);
  const panelBody = el('div', 'su-panel-body');
  panel.append(panelHead, panelBody);

  // ══ 结局画面 ══
  const ending = el('div', 'su-ending');
  ending.style.display = 'none';
  const endBox = el('div', 'su-end-box');
  const endKind = el('div', 'su-end-kind');
  const endTitle = el('div', 'su-end-title');
  const endText = el('div', 'su-end-text');
  const endStats = el('div', 'su-end-stats');
  const endBtn = el('button', 'su-end-btn', '再梦一次');
  endBox.append(endKind, endTitle, endText, endStats, endBtn);
  ending.appendChild(endBox);

  root.append(actCard, dlgWrap, toastWrap, panel, ending);
  // 镜头层挂在 root 上（不挂在 dlgWrap 里）——它是独立的一层，
  // 这样它的淡入淡出不受对话框自身的进出场影响。
  root.appendChild(mediaWrap);

  // ══════════════════════════════════════════════════════════
  //  状态
  // ══════════════════════════════════════════════════════════

  /** 当前对话队列。叙事一帧可能触发多段（主线 + 支线 + 事件），排队播。 */
  const queue = [];
  let showing = false;
  let actTimer = 0;
  let started = false;

  // ══════════════════════════════════════════════════════════
  //  对话框
  // ══════════════════════════════════════════════════════════

  const KIND_LABEL = {
    main: '主线',
    side: '支线',
    event: '关键事件',
    perspective: '视角插叙',
    boss: '首领',
  };

  /** 是否正在演出（宿主据此暂停游戏） */
  function isBusy() { return showing || actTimer > 0; }

  function playNext() {
    if (!queue.length) {
      showing = false;
      dlgWrap.classList.remove('on');
      // 对话结束 → 镜头层一起收（停留一下让最后一眼看清，再淡出）
      setTimeout(() => { if (!showing) hideMedia(); }, 900);
      if (hooks.onDialogClose) hooks.onDialogClose();
      return;
    }
    const d = queue.shift();
    showing = true;
    dlgWrap.classList.add('on');

    dlgKind.textContent = KIND_LABEL[d.kind] || '剧情';
    dlgKind.className = 'su-kind su-kind--' + (d.kind || 'main');
    dlgWho.textContent = d.speaker || '旁白';
    dlgText.textContent = d.text || '';

    // ── 镜头：有 sceneId 就切到这个镜头，没有就保持/收起 ──
    //
    // 为什么"没有 sceneId 时**不**立刻收起"：
    //   一个镜头位往往服务于**连续几段**对白（如第 47 波真相揭晓会
    //   连着说好几段）。如果每段没有 sceneId 的对白都把视频关掉，
    //   玩家会看到视频反复淡入淡出 —— 那才是真正的"过渡不好"。
    //   所以规则是：镜头一旦起来，就跟着这一串演出走；
    //   只有在整串演出的最后一段（队列空了）才收起。
    const sceneId = d.sceneId || (d.story && d.story.sceneId) || null;
    if (sceneId) {
      // 分段说明文字：用说话人，让玩家知道"镜头没换，是说话的人在换"
      showMedia(sceneId, { caption: slotCaption(sceneId, d) });
    }

    // 选项
    dlgChoices.replaceChildren();
    const choices = Array.isArray(d.choices) ? d.choices : null;
    if (choices && choices.length) {
      dlgHint.style.display = 'none';
      choices.forEach((c, i) => {
        const btn = el('button', 'su-choice');
        const t = el('span', 'su-choice-t', c.text || `选项 ${i + 1}`);
        btn.appendChild(t);
        // effect 是策划写的自由文案（「周默好感度 +1」），直接显示让玩家预判代价
        if (c.effect) btn.appendChild(el('span', 'su-choice-e', c.effect));
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (hooks.onChoice) hooks.onChoice(c, d);
          playNext();   // 选完就进下一段
        });
        dlgChoices.appendChild(btn);
      });
    } else {
      dlgHint.style.display = '';
    }

    if (!started) { started = true; if (hooks.onDialogOpen) hooks.onDialogOpen(); }
  }

  /** 镜头说明文字：镜头标题 + 当前说话人（换人不换镜时也能看清是谁在说）。 */
  function slotCaption(sceneId, d) {
    const slot = slotFor(sceneId);
    const title = (slot && slot.title) || '';
    const who = d && d.speaker && d.speaker !== '旁白' ? d.speaker : '';
    if (title && who) return title + ' · ' + who;
    return title || who;
  }

  // 点击对话框推进（有选项时不响应，逼玩家做选择）
  dlgWrap.addEventListener('click', () => {
    if (dlgChoices.childElementCount > 0) return;
    playNext();
  });

  /** 入队一段对白。叙事包的 host.showDialog 直接调它。 */
  function push(d) {
    queue.push(d);
    if (!showing) playNext();
  }

  // ══════════════════════════════════════════════════════════
  //  幕卡
  // ══════════════════════════════════════════════════════════

  function showAct(label, title, question) {
    actLabel.textContent = label;
    actTitle.textContent = title;
    actQ.textContent = question || '';
    actCard.classList.add('on');
    actTimer = 3.2;   // 秒
  }

  // ══════════════════════════════════════════════════════════
  //  演出 toast
  // ══════════════════════════════════════════════════════════

  const TONE_CLASS = { gold: 'gold', green: 'green', red: 'red', blue: 'blue' };

  function toast(title, body, tone, seconds) {
    const t = el('div', 'su-toast ' + (TONE_CLASS[tone] || 'gold'));
    t.appendChild(el('div', 'su-toast-t', title || ''));
    if (body) t.appendChild(el('div', 'su-toast-b', body));
    toastWrap.appendChild(t);
    // 入场
    requestAnimationFrame(() => t.classList.add('on'));
    const life = (seconds || 5) * 1000;
    setTimeout(() => {
      t.classList.remove('on');
      setTimeout(() => t.remove(), 300);
    }, life);
    // 最多同时 4 条，多了挤爆屏幕
    while (toastWrap.childElementCount > 4) toastWrap.firstElementChild.remove();
  }

  // ══════════════════════════════════════════════════════════
  //  日记 / 设定集面板
  // ══════════════════════════════════════════════════════════

  panelClose.addEventListener('click', () => { panel.style.display = 'none'; });

  /**
   * 打开日记面板。
   * @param {object} data 由 main.js 组装（章节 / 词条 / 支线 / 事件 / 插叙的进度与列表）
   */
  function openPanel(data) {
    panelBody.replaceChildren();

    // ── 章节条 ──
    if (data.chapters) {
      const sec = el('div', 'su-sec');
      sec.appendChild(el('div', 'su-sec-h', `📖 章节 · ${data.chapters.reached}/${data.chapters.total}`));
      const cur = data.currentChapter;
      if (cur) {
        const c = el('div', 'su-chapter');
        c.appendChild(el('div', 'su-chapter-t', cur.title));
        c.appendChild(el('div', 'su-chapter-g', '目标：' + cur.goal));
        if (cur.summary) c.appendChild(el('div', 'su-chapter-s', cur.summary));
        sec.appendChild(c);
      }
      if (data.act) {
        sec.appendChild(el('div', 'su-act-note',
          `${data.act.label} · ${data.act.title} —— ${data.act.question}`));
      }
      panelBody.appendChild(sec);
    }

    // ── 幕卡回顾（已到达的章节）──
    if (data.chapterList && data.chapterList.length) {
      const sec = el('div', 'su-sec');
      sec.appendChild(el('div', 'su-sec-h', `🗂 已到达的章节`));
      const grid = el('div', 'su-chip-grid');
      data.chapterList.forEach((c) => {
        const chip = el('span', 'su-chip' + (c.reached ? ' on' : ''), c.title);
        chip.title = c.summary || '';
        grid.appendChild(chip);
      });
      sec.appendChild(grid);
      panelBody.appendChild(sec);
    }

    // ── 世界观词条 ──
    if (data.lore) {
      const sec = el('div', 'su-sec');
      sec.appendChild(el('div', 'su-sec-h',
        `📘 世界观设定 · ${data.lore.unlocked}/${data.lore.total}（${data.lore.percent}%）`));
      (data.loreList || []).forEach((g) => {
        const row = el('div', 'su-lore' + (g.unlocked ? ' on' : ''));
        row.appendChild(el('span', 'su-lore-i', g.unlocked ? g.def.icon : '🔒'));
        const body = el('div', 'su-lore-body');
        body.appendChild(el('div', 'su-lore-t', g.unlocked ? g.def.title : '？？？'));
        body.appendChild(el('div', 'su-lore-b', g.unlocked ? g.def.brief : '随剧情推进解锁'));
        row.appendChild(body);
        sec.appendChild(row);
      });
      panelBody.appendChild(sec);
    }

    // ── 支线 ──
    if (data.sideList && data.sideList.length) {
      const sec = el('div', 'su-sec');
      sec.appendChild(el('div', 'su-sec-h',
        `📓 支线 · ${data.side.done}/${data.side.total} 完成`));
      data.sideList.forEach((s) => {
        const row = el('div', 'su-prog');
        row.appendChild(el('span', 'su-prog-n', s.def.title));
        const bar = el('span', 'su-prog-bar');
        const fill = el('i');
        fill.style.width = (s.total ? Math.round(s.step / s.total * 100) : 0) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        row.appendChild(el('span', 'su-prog-v', s.done ? '✓' : `${s.step}/${s.total}`));
        sec.appendChild(row);
      });
      panelBody.appendChild(sec);
    }

    // ── 关键事件 / 插叙 ──
    const two = el('div', 'su-two');
    if (data.eventProg) {
      const s = el('div', 'su-sec');
      s.appendChild(el('div', 'su-sec-h', `⚡ 关键事件 · ${data.eventProg.fired}/${data.eventProg.total}`));
      two.appendChild(s);
    }
    if (data.perspProg) {
      const s = el('div', 'su-sec');
      s.appendChild(el('div', 'su-sec-h', `🪞 视角插叙 · ${data.perspProg.fired}/${data.perspProg.total}`));
      two.appendChild(s);
    }
    if (two.childElementCount) panelBody.appendChild(two);

    panel.style.display = '';
  }

  function closePanel() { panel.style.display = 'none'; }
  function togglePanel(data) {
    if (panel.style.display === 'none') openPanel(data);
    else closePanel();
  }

  // ══════════════════════════════════════════════════════════
  //  结局
  // ══════════════════════════════════════════════════════════

  /**
   * 显示结局。
   * @param {object} e { id, kind, title, text, lines[] }
   * @param {object} stats 本局统计
   * @param {Function} onAgain 重开回调
   */
  function showEnding(e, stats, onAgain) {
    endKind.textContent = e.kind || '结局';
    endTitle.textContent = e.title || '';
    endText.textContent = e.text || '';

    endStats.replaceChildren();
    const rows = [
      ['守住的波次', stats.wave],
      ['击杀', stats.kills],
      ['获得灵魂', stats.souls],
      ['完成的支线', stats.sideDone !== undefined ? stats.sideDone : '—'],
      ['解锁的词条', stats.loreUnlocked !== undefined ? stats.loreUnlocked : '—'],
    ];
    rows.forEach(([k, v]) => {
      const r = el('div', 'su-end-row');
      r.appendChild(el('span', null, k));
      r.appendChild(el('b', null, String(v)));
      endStats.appendChild(r);
    });

    ending.style.display = '';
    requestAnimationFrame(() => ending.classList.add('on'));
    endBtn.onclick = () => {
      ending.classList.remove('on');
      setTimeout(() => { ending.style.display = 'none'; }, 400);
      if (onAgain) onAgain();
    };
  }

  function hideEnding() {
    ending.classList.remove('on');
    ending.style.display = 'none';
  }

  // ══════════════════════════════════════════════════════════
  //  每帧推进（幕卡倒计时）
  // ══════════════════════════════════════════════════════════

  function update(dt) {
    if (actTimer > 0) {
      actTimer -= dt;
      if (actTimer <= 0) actCard.classList.remove('on');
    }
  }

  return {
    push, toast, showAct, update,
    isBusy,
    /** 队列里还有几段没播 */
    get pending() { return queue.length; },
    get dialogOpen() { return showing; },
    openPanel, closePanel, togglePanel,
    get panelOpen() { return panel.style.display !== 'none'; },
    showEnding, hideEnding,
    // ── 剧情镜头 ──
    showMedia, hideMedia, setMediaFit,
    /** 当前镜头编号（没在演时为 null） */
    get mediaScene() { return mediaWrap.classList.contains('on') ? mediaSlotId : null; },
    /** 当前镜头是否真的有画面（video 出画 或 poster 加载成功） */
    get mediaReady() {
      if (!mediaWrap.classList.contains('on')) return false;
      return mediaLayers.some((l) => {
        const v = l.querySelector('video');
        if (v && !v.hidden && v.readyState >= 2) return true;
        const i = l.querySelector('img');
        return !!(i && !i.hidden && i.complete && i.naturalWidth > 0);
      });
    },
    /**
     * 镜头层的内部状态快照（验收/排查用）。
     *
     * 为什么要暴露这个：双缓冲有一个**从像素上看不出来**的不变量 ——
     * 「当前可见的那一层，必须就是 mediaTop 指向的那一层」。
     * 若两者错位，下一刀切换会把**正在显示的层**当成 incoming 清掉，
     * 双缓冲退化成单缓冲；本地因为 CSS 淡出有 600ms，新视频又加载得快，
     * 所以肉眼看不出问题，只有网络慢时才露底成黑框。
     * 这类"本地永远测不出、上线才犯"的问题必须靠内部不变量断言兜住。
     */
    mediaDebug() {
      return {
        top: mediaTop,
        slot: mediaSlotId,
        on: mediaWrap.classList.contains('on'),
        gen: mediaGen,
        layers: mediaLayers.map((l) => ({
          opacity: Number(getComputedStyle(l).opacity),
          hasVideo: !!l.querySelector('video'),
          hasImg: !!l.querySelector('img'),
        })),
      };
    },
    /** 立刻清空全部演出（重开一局时用） */
    reset() {
      queue.length = 0;
      showing = false;
      started = false;
      actTimer = 0;
      dlgWrap.classList.remove('on');
      actCard.classList.remove('on');
      toastWrap.replaceChildren();
      // ⚠️ 先作废在飞的镜头续体，再清层。
      //    否则 reset 时正在加载的那个 showMedia 会在 .then() 里
      //    把 'on' 和 opacity:1 重新加到已经被清空的层上 → 黑框。
      mediaGen++;
      mediaSlotId = null;
      mediaWrap.classList.remove('on');
      mediaLayers.forEach(clearLayer);
      hideEnding();
      closePanel();
    },
    nodes: { actCard, dlgWrap, toastWrap, panel, ending, endBtn, mediaWrap, mediaStage },
  };
}
