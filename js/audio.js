/*!
 * tim1e · audio.js
 * 全部音效用 WebAudio 振荡器即时合成，没有音频文件。
 * 首次用户交互（点击「开始」）之后才创建 AudioContext。
 */
(function () {
  'use strict';

  function create() {
    var ctx = null, master = null, on = true;

    function ensure() {
      if (!on) return null;
      if (!ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch (e) { return null; }
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended' && ctx.resume) {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
      return ctx;
    }

    function tone(freq, dur, type, vol, when, slideTo) {
      var c = ensure();
      if (!c) return;
      var t = c.currentTime + (when || 0);
      var o = c.createOscillator(), g = c.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.15, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(master);
      o.start(t);
      o.stop(t + dur + 0.03);
    }

    var SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
    var BASE = 523.25; // C5

    return {
      resume: function () { ensure(); },
      setOn: function (v) {
        on = !!v;
        if (!on && ctx && ctx.state === 'running' && ctx.suspend) ctx.suspend();
      },
      isOn: function () { return on; },
      tick: function () { tone(1900, 0.03, 'square', 0.018); },
      chime: function (n) {
        var semi = SCALE[(Math.max(1, n) - 1) % SCALE.length];
        var f = BASE * Math.pow(2, semi / 12);
        tone(f, 0.32, 'triangle', 0.16);
        tone(f * 2, 0.18, 'sine', 0.05, 0.03);
      },
      loop: function () {
        tone(392, 0.45, 'sine', 0.1);
        tone(587.33, 0.6, 'sine', 0.07, 0.09);
      },
      goldSpawn: function () {
        tone(1318.5, 0.25, 'sine', 0.06);
        tone(1760, 0.3, 'sine', 0.05, 0.08);
      },
      gold: function () {
        [0, 4, 7, 12, 16].forEach(function (s, i) {
          tone(BASE * Math.pow(2, s / 12), 0.35, 'triangle', 0.12, i * 0.06);
        });
      },
      charge: function () {
        tone(659.25, 0.2, 'square', 0.04);
        tone(987.77, 0.3, 'square', 0.04, 0.1);
      },
      rewind: function () {
        tone(1000, 0.5, 'sawtooth', 0.05, 0, 140);
        tone(500, 0.5, 'triangle', 0.08, 0, 70);
      },
      death: function () {
        tone(180, 0.8, 'sine', 0.25, 0, 40);
        tone(95, 1.0, 'triangle', 0.14);
      }
    };
  }

  window.Tim1eAudio = { create: create };
})();
