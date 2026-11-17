/*!
 * tim1e · main.js
 * 页面状态机、输入（鼠标 / 触屏相对拖动 / 键盘）、HUD、设置、档案（localStorage）。
 */
(function () {
  'use strict';
  var Core = window.Tim1eCore, CFG = Core.CFG, RenderLib = window.Tim1eRender;
  function $(id) { return document.getElementById(id); }

  var stage = $('stage'), canvas = $('stageCanvas');
  var hud = $('hud'), toastEl = $('toast');
  var cards = { title: $('titleCard'), pause: $('pauseCard'), over: $('overCard') };
  var view = new RenderLib.Renderer(canvas);
  var audio = window.Tim1eAudio.create();
  var mqCoarse = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
  var mqReduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  /* ---------------- 存储 ---------------- */
  var STORE_KEY = 'tim1e.archive.v1', SET_KEY = 'tim1e.settings.v1';
  function readJSON(k) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : null; }
    catch (e) { return null; }
  }
  function writeJSON(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }
  var store = readJSON(STORE_KEY) || {};
  store.best = Number(store.best) || 0;
  store.runs = Number(store.runs) || 0;
  store.total = Number(store.total) || 0;
  if (!Array.isArray(store.prints)) store.prints = [];
  function saveStore() {
    if (!writeJSON(STORE_KEY, store)) {
      // 空间不足时放弃缩略图，保住数字
      store.prints = store.prints.slice(0, 2);
      if (!writeJSON(STORE_KEY, store)) { store.prints = []; writeJSON(STORE_KEY, store); }
    }
  }

  var settings = readJSON(SET_KEY) || {};
  if (typeof settings.sound !== 'boolean') settings.sound = true;
  if (typeof settings.relaxed !== 'boolean') settings.relaxed = false;
  if (typeof settings.reduce !== 'boolean') settings.reduce = null; // null = 跟随系统

  /* ---------------- 状态 ---------------- */
  var state = 'title';            // title | playing | paused | dying | over
  var game = null;
  var acc = 0, last = performance.now(), clock = 0, dyingT = 0;
  var keys = { up: false, down: false, left: false, right: false };
  var target = null, anchor = null;
  var lastSec = 0, lowWarned = false, posterURL = null;
  var firstLoopShown = false, firstGoldShown = false;

  var params = new URLSearchParams(location.search);
  var fixedSeed = params.has('seed') ? (parseInt(params.get('seed'), 10) | 0) : null;

  function isCoarse() { return !!(mqCoarse && mqCoarse.matches); }
  function reduced() {
    return settings.reduce === null ? !!(mqReduce && mqReduce.matches) : settings.reduce;
  }

  /* ---------------- 设置 ---------------- */
  function applySettings() {
    var rm = reduced();
    document.documentElement.classList.toggle('reduce-motion', rm);
    view.reduced = rm;
    audio.setOn(settings.sound);
    setToggles('sound', settings.sound);
    setToggles('relaxed', settings.relaxed);
    setToggles('reduce', rm);
  }
  function setToggles(name, on) {
    var list = document.querySelectorAll('[data-opt="' + name + '"]');
    for (var i = 0; i < list.length; i++) {
      list[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      var s = list[i].querySelector('.state');
      if (s) s.textContent = on ? '开' : '关';
    }
  }
  function toggleSound() {
    settings.sound = !settings.sound;
    writeJSON(SET_KEY, settings);
    applySettings();
    if (settings.sound) audio.resume();
    toast(settings.sound ? '声音：开' : '声音：关', 1400);
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-opt]') : null;
    if (!b) return;
    var name = b.getAttribute('data-opt');
    if (name === 'sound') { toggleSound(); return; }
    if (name === 'relaxed') {
      settings.relaxed = !settings.relaxed;
      if (state === 'paused') toast('从容模式将在下一局生效', 1800);
    }
    if (name === 'reduce') settings.reduce = !reduced();
    writeJSON(SET_KEY, settings);
    applySettings();
  });
  if (mqReduce) {
    var onMq = function () { if (settings.reduce === null) applySettings(); };
    if (mqReduce.addEventListener) mqReduce.addEventListener('change', onMq);
    else if (mqReduce.addListener) mqReduce.addListener(onMq);
  }

  /* ---------------- 界面切换 ---------------- */
  function show(name) {
    Object.keys(cards).forEach(function (k) { cards[k].hidden = k !== name; });
    if (name && cards[name]) {
      var btn = cards[name].querySelector('.btn.primary');
      if (btn) { try { btn.focus({ preventScroll: true }); } catch (e) { btn.focus(); } }
    }
  }
  function lock(on) { document.documentElement.classList.toggle('lock', on); }

  var toastTimer = 0;
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, ms || 2600);
  }

  function startGame() {
    var seed = fixedSeed !== null ? fixedSeed : (Math.random() * 0x7fffffff) | 0;
    game = Core.createGame({ seed: seed, relaxed: settings.relaxed });
    acc = 0; lastSec = 0; lowWarned = false;
    target = null; anchor = null;
    keys.up = keys.down = keys.left = keys.right = false;
    view.reset();
    hudCache = {};
    state = 'playing';
    show(null);
    hud.hidden = false;
    window.scrollTo(0, stage.offsetTop);
    lock(true);
    audio.resume();
    try { canvas.focus({ preventScroll: true }); } catch (e) { /* noop */ }
    toast(isCoarse()
      ? '在屏幕任意处拖动，带粉色的「1」去吃黄色刻度'
      : '移动鼠标（或方向键 / WASD），带粉色的「1」去吃黄色刻度', 3600);
    updateHUD();
  }

  function pause() {
    if (state !== 'playing') return;
    state = 'paused';
    anchor = null;
    keys.up = keys.down = keys.left = keys.right = false;
    show('pause');
  }
  function resume() {
    if (state !== 'paused') return;
    state = 'playing';
    acc = 0;
    show(null);
    try { canvas.focus({ preventScroll: true }); } catch (e) { /* noop */ }
  }
  function goTitle() {
    state = 'title';
    hud.hidden = true;
    lock(false);
    show('title');
    updateTitleBest();
  }

  /* ---------------- 结算 ---------------- */
  function showOver() {
    state = 'over';
    var g = game;
    var stats = {
      score: g.score, loops: g.loopIndex, erased: g.erased, rewinds: g.rewinds,
      cause: g.deathCause, seed: g.startSeed, run: store.runs + 1, date: new Date()
    };
    store.runs++;
    store.total += g.collected;
    var isBest = g.score > store.best;
    if (isBest) store.best = g.score;

    $('overKicker').textContent = 'echo print № ' + ('00' + stats.run).slice(-3);
    $('overTitle').textContent = g.deathCause === 'echo' ? '你撞上了过去的自己' : '余秒耗尽';
    $('overLine').textContent = g.deathCause === 'echo'
      ? '撞上的是 ' + (g.deathAgo * 6) + ' 秒前的你。它只是在原路重复你走过的每一步。'
      : '余秒流完了，钟面停了下来。下一局多吃几枚刻度。';
    $('ovScore').textContent = String(g.score);
    $('ovLoops').textContent = String(g.loopIndex);
    $('ovErased').textContent = String(g.erased);
    $('ovBest').textContent = String(store.best);
    $('overBadge').hidden = !(isBest && g.score > 0);

    var img = $('overPoster'), save = $('btnSave');
    save.setAttribute('aria-disabled', 'true');
    save.removeAttribute('href');
    img.removeAttribute('src');

    var poster = null;
    try { poster = RenderLib.makePoster(g, stats); } catch (e) { if (window.console) console.warn('poster failed', e); }
    if (poster) {
      var fname = 'tim1e-echo-print-' + ('00' + stats.run).slice(-3) + '.png';
      var setURL = function (url) {
        img.src = url;
        save.href = url;
        save.setAttribute('download', fname);
        save.removeAttribute('aria-disabled');
      };
      if (poster.toBlob) {
        poster.toBlob(function (b) {
          if (!b) { setURL(poster.toDataURL('image/png')); return; }
          if (posterURL) URL.revokeObjectURL(posterURL);
          posterURL = URL.createObjectURL(b);
          setURL(posterURL);
        }, 'image/png');
      } else {
        setURL(poster.toDataURL('image/png'));
      }
      try {
        var tc = document.createElement('canvas');
        tc.width = 216; tc.height = 270;
        tc.getContext('2d').drawImage(poster, 0, 0, 216, 270);
        store.prints.unshift({
          img: tc.toDataURL('image/jpeg', 0.72),
          score: g.score, loops: g.loopIndex, run: stats.run, t: Date.now()
        });
        store.prints = store.prints.slice(0, 6);
      } catch (e) { /* noop */ }
    }
    saveStore();
    renderArchive();
    hud.hidden = true;
    lock(false);
    show('over');
  }

  /* ---------------- 档案 ---------------- */
  function updateTitleBest() {
    var el = $('titleBest');
    if (store.best > 0) { el.hidden = false; el.querySelector('b').textContent = String(store.best); }
    else el.hidden = true;
  }
  function renderArchive() {
    $('arBest').textContent = String(store.best);
    $('arRuns').textContent = String(store.runs);
    $('arTotal').textContent = String(store.total);
    var grid = $('arGrid');
    grid.textContent = '';
    var valid = store.prints.filter(function (p) {
      return p && typeof p.img === 'string' && p.img.indexOf('data:image/') === 0;
    });
    $('arEmpty').hidden = valid.length > 0;
    valid.forEach(function (p, i) {
      var fig = document.createElement('figure');
      fig.style.setProperty('--r', ((i % 2 ? 1 : -1) * (1 + (i % 3))) + 'deg');
      var im = document.createElement('img');
      im.src = p.img;
      im.alt = '第 ' + (Number(p.run) || '?') + ' 次循环的回声印刷品';
      im.loading = 'lazy';
      var cap = document.createElement('figcaption');
      var d = new Date(Number(p.t) || Date.now());
      cap.textContent = '№' + ('00' + (Number(p.run) || 0)).slice(-3) + ' · ' + (Number(p.score) || 0) + ' 刻度 · ' +
        (Number(p.loops) || 0) + ' 圈 · ' + (d.getMonth() + 1) + '/' + d.getDate();
      fig.appendChild(im);
      fig.appendChild(cap);
      grid.appendChild(fig);
    });
  }
  $('btnClear').addEventListener('click', function () {
    if (!window.confirm('清空本机上的全部回声档案（最佳分数、局数与印刷品）？')) return;
    store = { best: 0, runs: 0, total: 0, prints: [] };
    saveStore();
    renderArchive();
    updateTitleBest();
  });

  /* ---------------- HUD ---------------- */
  var hudCache = {};
  var energyBar = $('hudEnergy'), chargeEl = $('hudCharge');
  function setText(id, v) {
    if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; }
  }
  function updateHUD() {
    var g = game;
    if (!g) return;
    setText('hudScore', String(g.score));
    setText('hudLoop', String(g.loopIndex + 1));
    var e = Math.max(0, g.energy);
    setText('hudEnergyNum', e.toFixed(1));
    var sc = (e / CFG.ENERGY_MAX).toFixed(3);
    if (hudCache.bar !== sc) { hudCache.bar = sc; energyBar.style.transform = 'scaleX(' + sc + ')'; }
    var low = e < 3 && g.mode !== 'over';
    if (hudCache.low !== low) { hudCache.low = low; hud.classList.toggle('low', low); }
    var ready = g.charges > 0;
    if (hudCache.ready !== ready) { hudCache.ready = ready; chargeEl.classList.toggle('ready', ready); }
    var next = (Math.floor(g.loopIndex / CFG.CHARGE_EVERY) + 1) * CFG.CHARGE_EVERY;
    if (next <= g.lastChargeLoop) next += CFG.CHARGE_EVERY;
    setText('hudChargeTxt', ready ? '就绪' : '第' + (next + 1) + '圈');
  }

  /* ---------------- 事件 → 声光 ---------------- */
  function handleEvents() {
    var ev = game.events;
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      switch (e.type) {
        case 'shard':
          view.burst(e.x, e.y, RenderLib.INK.yellow, 14, 0.5);
          view.text(e.x, e.y, '+1', RenderLib.INK.blue);
          audio.chime(e.score);
          break;
        case 'gold':
          view.burst(e.x, e.y, RenderLib.INK.gold, 26, 0.8);
          view.text(e.x, e.y, '+' + CFG.GOLD_BONUS, RenderLib.INK.pink);
          if (e.removed) {
            view.burst(e.removed.x, e.removed.y, RenderLib.INK.blue, 30, 0.9);
            view.text(e.removed.x, e.removed.y, '抹去', RenderLib.INK.blue);
          }
          audio.gold();
          toast(e.removed ? '最旧的那道回声被抹去了' : '金色的 1：+' + CFG.GOLD_BONUS, 2000);
          break;
        case 'goldSpawn':
          audio.goldSpawn();
          if (!firstGoldShown) {
            firstGoldShown = true;
            toast('金色的 1 出现了：吃掉它，抹去最旧的回声', 3200);
          }
          break;
        case 'loop':
          audio.loop();
          view.ring(RenderLib.INK.pink);
          if (!firstLoopShown) {
            firstLoopShown = true;
            toast('那个蓝色的 1 是 6 秒前的你——别碰它', 3400);
          }
          break;
        case 'charge':
          audio.charge();
          toast('又攒下了一枚「备用的一秒」', 2200);
          break;
        case 'rewindStart':
          audio.rewind();
          view.shake = 0.5;
          view.flash = 0.6; view.flashColor = RenderLib.INK.blue;
          toast('倒带一秒！备用的一秒已用掉', 2200);
          anchor = null;
          break;
        case 'death':
          audio.death();
          view.shake = 1;
          view.flash = 1; view.flashColor = RenderLib.INK.pink;
          view.burst(e.x, e.y, RenderLib.INK.pink, 40, 1.1);
          view.burst(e.x, e.y, RenderLib.INK.yellow, 20, 0.7);
          break;
      }
    }
    ev.length = 0;

    var sec = Math.floor(game.tick / 60);
    if (sec !== lastSec) { lastSec = sec; audio.tick(); }
    if (game.energy < 3 && !lowWarned && game.mode === 'play') {
      lowWarned = true;
      toast('余秒不多了——快去吃刻度', 2000);
    } else if (game.energy > 5) lowWarned = false;
  }

  /* ---------------- 输入 ---------------- */
  function arenaFromClient(x, y) {
    var r = canvas.getBoundingClientRect();
    return [(x - r.left - view.cx) / view.R, (y - r.top - view.cy) / view.R];
  }
  function clampArena(p, lim) {
    var m = Math.hypot(p[0], p[1]);
    if (m > lim) { p[0] *= lim / m; p[1] *= lim / m; }
    return p;
  }
  function currentInput() {
    var kx = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    var ky = (keys.down ? 1 : 0) - (keys.up ? 1 : 0);
    if (kx || ky) { target = null; return { dx: kx, dy: ky }; }
    if (target) return { tx: target[0], ty: target[1] };
    return null;
  }

  canvas.addEventListener('pointerdown', function (e) {
    if (state !== 'playing') return;
    audio.resume();
    if (e.pointerType === 'mouse') {
      target = clampArena(arenaFromClient(e.clientX, e.clientY), 1);
      return;
    }
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    anchor = { id: e.pointerId, sx: e.clientX, sy: e.clientY, px: game.px, py: game.py };
    target = [game.px, game.py];
  });
  canvas.addEventListener('pointermove', function (e) {
    if (state !== 'playing') return;
    if (e.pointerType === 'mouse') {
      target = clampArena(arenaFromClient(e.clientX, e.clientY), 1);
      return;
    }
    if (!anchor || e.pointerId !== anchor.id) return;
    e.preventDefault();
    // 相对拖动：手指移动多少，目标点就移动多少（略放大），手指不会挡住角色
    var gain = 1.35 / view.R;
    var dx = (e.clientX - anchor.sx) * gain, dy = (e.clientY - anchor.sy) * gain;
    var tx = anchor.px + dx, ty = anchor.py + dy;
    var m = Math.hypot(tx, ty), lim = CFG.ARENA_R;
    if (m > lim) {
      tx *= lim / m; ty *= lim / m;
      anchor.px = tx - dx; anchor.py = ty - dy; // 顶到边缘后反向拖动能立刻响应
    }
    target = [tx, ty];
  });
  function endTouch(e) { if (anchor && e.pointerId === anchor.id) anchor = null; }
  canvas.addEventListener('pointerup', endTouch);
  canvas.addEventListener('pointercancel', endTouch);
  canvas.addEventListener('contextmenu', function (e) { if (state === 'playing') e.preventDefault(); });

  var KEYMAP = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right'
  };
  function stageVisible() {
    var r = stage.getBoundingClientRect();
    return r.bottom > window.innerHeight * 0.5 && r.top < window.innerHeight * 0.5;
  }
  window.addEventListener('keydown', function (e) {
    var k = KEYMAP[e.code];
    if (k && state === 'playing') { keys[k] = true; e.preventDefault(); return; }
    var tag = e.target && e.target.tagName;
    var onControl = tag === 'BUTTON' || tag === 'A' || tag === 'INPUT';
    if ((e.code === 'Enter' || e.code === 'Space' || e.code === 'NumpadEnter') && !onControl) {
      if ((state === 'title' || state === 'over') && stageVisible()) { e.preventDefault(); startGame(); }
      else if (state === 'paused') { e.preventDefault(); resume(); }
      else if (state === 'playing') e.preventDefault();
      return;
    }
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (state === 'playing') { e.preventDefault(); pause(); }
      else if (state === 'paused') { e.preventDefault(); resume(); }
      return;
    }
    if (e.code === 'KeyM' && !e.repeat && !onControl) toggleSound();
  });
  window.addEventListener('keyup', function (e) {
    var k = KEYMAP[e.code];
    if (k) keys[k] = false;
  });
  window.addEventListener('blur', function () {
    keys.up = keys.down = keys.left = keys.right = false;
    pause();
  });
  document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); });

  /* ---------------- 按钮 ---------------- */
  $('btnStart').addEventListener('click', startGame);
  $('btnRetry').addEventListener('click', startGame);
  $('btnPause').addEventListener('click', pause);
  $('btnResume').addEventListener('click', resume);
  $('btnQuit').addEventListener('click', goTitle);
  $('btnHome').addEventListener('click', goTitle);
  $('btnSave').addEventListener('click', function (e) {
    if (this.getAttribute('aria-disabled') === 'true') e.preventDefault();
  });

  /* ---------------- 主循环 ---------------- */
  function frame(now) {
    var dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    clock += dt;

    if (state === 'playing') {
      acc += dt;
      var n = 0;
      while (acc >= CFG.TICK && n < 8) {
        Core.step(game, currentInput());
        acc -= CFG.TICK;
        n++;
        handleEvents();
        if (game.mode === 'over') break;
      }
      if (n >= 8) acc = 0;
      if (game.mode === 'over') {
        state = 'dying';
        dyingT = view.reduced ? 0.6 : 1.1;
        anchor = null;
      }
    } else if (state === 'dying') {
      dyingT -= dt;
      if (dyingT <= 0) showOver();
    }

    if (game && state !== 'title') {
      view.drawGame(game, dt, clock, {
        paused: state === 'paused' || state === 'over',
        hints: store.runs < 2
      });
    } else {
      view.drawAttract(dt, clock);
    }
    if (game && (state === 'playing' || state === 'dying')) updateHUD();
    requestAnimationFrame(frame);
  }

  /* ---------------- 启动 ---------------- */
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(function () { view.resize(); }).observe(stage);
  } else {
    window.addEventListener('resize', function () { view.resize(); });
  }
  view.resize();
  applySettings();
  updateTitleBest();
  renderArchive();
  document.documentElement.classList.add('js');
  requestAnimationFrame(function (t) { last = t; frame(t); });
})();
