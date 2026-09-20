// sfx.js — 効果音。public/audio/*.mp3 を WebAudio で鳴らす。
//
// 音源はすべて CC0 素材を ffmpeg で加工したもの（scripts/build-audio.sh で再生成できる）。
// 自動再生ポリシーがあるので、最初のユーザー操作で unlock() を呼ぶこと。
// 読み込みに失敗した音は、その場で合成した代替音にフォールバックする。

const BASE = './audio/';

/** 論理名 → ファイル名 */
const CLIPS = {
  place: 'place.mp3',
  placeCpu: 'place-cpu.mp3',
  water: 'combo-water.mp3',
  fire: 'combo-fire.mp3',
  thunder: 'combo-thunder.mp3',
  god: 'combo-god.mp3',
  foul: 'foul.mp3',
  break: 'break.mp3',
  flip: 'flip.mp3',
  speedCall: 'speed-call.mp3',
  danger: 'danger.mp3',
  chance: 'chance.mp3',
  finishWin: 'finish-win.mp3',
  finishLose: 'finish-lose.mp3',
};

/** コンボ段階 1..4 に対応するクリップ */
const SURGE = [null, 'water', 'fire', 'thunder', 'god'];

export function createSFX() {
  let ctx = null;
  let master = null;
  let comp = null;
  let muted = false;
  let loading = null;
  const buffers = new Map();

  try {
    muted = localStorage.getItem('jevspeed.muted') === '1';
  } catch (_) { /* localStorage が無い環境でも動かす */ }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      // フィニッシュで音が重なっても潰れないよう、軽く叩いてから出す
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 24;
      comp.ratio.value = 6;
      comp.attack.value = 0.003;
      comp.release.value = 0.22;
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.85;
      comp.connect(master);
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  /** 全クリップを先読みする。失敗したものは合成にフォールバックするので握り潰す */
  function preload() {
    if (loading) return loading;
    if (!ensure()) return Promise.resolve();
    loading = Promise.all(Object.entries(CLIPS).map(async ([key, file]) => {
      try {
        const res = await fetch(BASE + file);
        if (!res.ok) throw new Error(`${res.status}`);
        const buf = await res.arrayBuffer();
        buffers.set(key, await ctx.decodeAudioData(buf));
      } catch (_) {
        // 読めなければ合成音で代替する
      }
    }));
    return loading;
  }

  /**
   * クリップを 1 発鳴らす。
   * @param {string} key CLIPS のキー
   * @param {{gain?:number, rate?:number, delay?:number, pan?:number}} [opts]
   * @returns {boolean} 鳴らせたか（false なら呼び出し側が合成で補う）
   */
  function play(key, opts) {
    if (muted || !ensure()) return false;
    const buf = buffers.get(key);
    if (!buf) return false;
    const o = opts || {};
    const t0 = ctx.currentTime + (o.delay || 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = Math.max(0.35, Math.min(2.6, o.rate || 1));
    const g = ctx.createGain();
    g.gain.value = Math.max(0, o.gain != null ? o.gain : 1);
    src.connect(g);
    if (o.pan != null && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      g.connect(p);
      p.connect(comp);
    } else {
      g.connect(comp);
    }
    src.start(t0);
    return true;
  }

  // -------------------------------------------------------------- 合成の代替音

  /** 単発のオシレータ音。mp3 が無いときの保険 */
  function tone(o) {
    if (!ensure()) return;
    const t0 = ctx.currentTime + (o.delay || 0);
    const dur = o.dur || 0.18;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq || 440, t0);
    if (o.freqTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain != null ? o.gain : 0.2), t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(comp);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // -------------------------------------------------------------- 効果音

  /** カードを置いた音。コンボが伸びるほど高く・強くなる */
  function place(combo) {
    const n = Math.max(1, combo | 0);
    const rate = Math.min(1.55, 1 + (n - 1) * 0.035);
    const gain = Math.min(1.35, 0.85 + n * 0.035);
    if (!play('place', { rate, gain })) {
      tone({ type: 'triangle', freq: 520 * rate, freqTo: 780 * rate, dur: 0.12, gain: 0.16 });
    }
  }

  /** Jev が置いた音。こちらは低く、追い立てるように少しずつ速くなる */
  function placeEnemy(combo) {
    const n = Math.max(1, combo | 0);
    const rate = Math.min(1.35, 0.95 + (n - 1) * 0.03);
    const gain = Math.min(1.2, 0.72 + n * 0.035);
    if (!play('placeCpu', { rate, gain })) {
      tone({ type: 'sawtooth', freq: 300 * rate, freqTo: 200 * rate, dur: 0.14, gain: 0.1 });
    }
  }

  /** コンボ段階の効果音。tier 1=水 2=炎 3=雷 4=極限 */
  function surge(tier, friendly) {
    const t = Math.max(1, Math.min(4, tier | 0));
    const key = SURGE[t];
    // 相手のコンボは少しピッチを下げて、こちらを見下ろすように鳴らす
    const rate = friendly ? 1.0 : 0.88;
    if (!play(key, { rate, gain: 0.85 + t * 0.06 })) {
      tone({ type: 'square', freq: 440 * (friendly ? 1.5 : 0.7), freqTo: 180, dur: 0.4, gain: 0.16 });
    }
    // 段階が上がった合図の三音。上がる/下がるで立場を表す
    const dir = friendly ? 1 : -1;
    for (let i = 0; i < 3; i++) {
      tone({ type: 'triangle', freq: 660 * Math.pow(2, (dir * (i + t * 2)) / 12), dur: 0.11, gain: 0.055, delay: 0.06 * i });
    }
  }

  function foul() {
    if (!play('foul', { gain: 1.0 })) {
      tone({ type: 'square', freq: 165, freqTo: 70, dur: 0.45, gain: 0.2 });
    }
  }

  function brk() {
    if (!play('break', { gain: 0.9 })) {
      tone({ type: 'triangle', freq: 520, freqTo: 140, dur: 0.3, gain: 0.14 });
    }
  }

  function flip() {
    if (!play('flip', { gain: 0.9, rate: 1.05 })) {
      tone({ type: 'triangle', freq: 420, freqTo: 620, dur: 0.18, gain: 0.12 });
    }
  }

  /** 「スピード！」の宣言 */
  function speedCall() {
    if (!play('speedCall', { gain: 1.0 })) {
      tone({ type: 'triangle', freq: 440, freqTo: 1200, dur: 0.35, gain: 0.18 });
    }
  }

  /** 相手が残りわずか — ピンチの合図 */
  function danger() {
    if (!play('danger', { gain: 1.0 })) {
      tone({ type: 'sine', freq: 82, freqTo: 44, dur: 1.1, gain: 0.26 });
    }
  }

  /** 自分が残りわずか — チャンスの合図 */
  function chance() {
    if (!play('chance', { gain: 0.9 })) {
      tone({ type: 'triangle', freq: 880, freqTo: 1320, dur: 0.4, gain: 0.14 });
    }
  }

  /** フィニッシュ。「バチコーン」。約 0.18 秒後に一撃が来る作りになっている */
  function finish(won) {
    if (!play(won ? 'finishWin' : 'finishLose', { gain: 1.0 })) {
      tone({ type: 'sine', freq: 110, freqTo: 30, dur: 1.5, gain: 0.35 });
      tone({ type: 'square', freq: won ? 660 : 494, dur: 1.0, gain: 0.12, delay: 0.02 });
    }
  }

  // -------------------------------------------------------------- 制御

  function unlock() {
    ensure();
    preload();
  }

  function setMuted(v) {
    muted = !!v;
    try { localStorage.setItem('jevspeed.muted', muted ? '1' : '0'); } catch (_) {}
    if (master) master.gain.value = muted ? 0 : 0.85;
    if (!muted) unlock();
  }

  const guard = (fn) => (...args) => { if (!muted) { try { fn(...args); } catch (_) {} } };

  return {
    unlock,
    preload,
    setMuted,
    isMuted: () => muted,
    /** デバッグ用: 読み込めたクリップ名 */
    loaded: () => [...buffers.keys()],
    place: guard(place),
    placeEnemy: guard(placeEnemy),
    surge: guard(surge),
    foul: guard(foul),
    break: guard(brk),
    flip: guard(flip),
    speedCall: guard(speedCall),
    danger: guard(danger),
    chance: guard(chance),
    finish: guard(finish),
  };
}
