// vfx.js — ヒットストップ / スローモーション / 粒子 / 衝撃波 / 画面演出 (契約 §5.3)
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const PARTICLE_CAP = 3000;
const RING_CAP = 14;

// ---------------------------------------------------------------- パーティクル shader

const PARTICLE_VS = /* glsl */`
attribute vec3 aVel;
attribute vec3 aColor;
attribute float aStart;
attribute float aLife;
attribute float aSize;
uniform float uTime;
uniform float uPR;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aStart;
  float k = age / max(aLife, 0.0001);
  vColor = aColor;
  if (k < 0.0 || k >= 1.0) {
    vAlpha = 0.0;
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // 簡易物理: 重力 + 空気抵抗
  float drag = 1.0 - exp(-1.9 * age);
  vec3 p = position + aVel * (drag / 1.9) + vec3(0.0, -3.4, 0.0) * 0.5 * age * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float fade = 1.0 - k;
  vAlpha = fade * fade;
  float dist = max(-mv.z, 0.001);
  gl_PointSize = clamp(aSize * uPR * (330.0 / dist) * (0.4 + 0.6 * fade), 1.0, 120.0);
}
`;

const PARTICLE_FS = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  float a = pow(1.0 - r, 1.7) * vAlpha;
  gl_FragColor = vec4(vColor * (1.0 + 1.4 * (1.0 - r)), a);
}
`;

// ---------------------------------------------------------------- 画面演出パス（色収差 + フラッシュ + ビネット）

const FX_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uAberration: { value: 0.0 },
    uFlashColor: { value: new THREE.Color(0xffffff) },
    uFlash: { value: 0.0 },
    uVignette: { value: 0.32 },
    uTime: { value: 0.0 },
    uWarp: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uAberration;
    uniform vec3 uFlashColor;
    uniform float uFlash;
    uniform float uVignette;
    uniform float uTime;
    uniform float uWarp;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float d = length(c);
      // レンズ歪み（スローモーション時に微かに効かせる）
      vec2 uvw = vUv + c * d * d * uWarp;
      // RGB シフト（中心からの距離に比例）
      vec2 off = c * uAberration * (0.35 + d);
      float r = texture2D(tDiffuse, uvw + off).r;
      float g = texture2D(tDiffuse, uvw).g;
      float b = texture2D(tDiffuse, uvw - off).b;
      vec3 col = vec3(r, g, b);
      // 走査ノイズ（色収差が強い時だけ）
      if (uAberration > 0.0005) {
        float n = fract(sin((vUv.y * 431.0 + uTime * 7.0)) * 43758.5453);
        col += (n - 0.5) * uAberration * 2.2;
      }
      // ビネット
      col *= smoothstep(1.02, 0.28, d * (1.0 + uVignette));
      // フラッシュ
      col = mix(col, uFlashColor, clamp(uFlash, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

// ================================================================ createVFX

export function createVFX(table3D) {
  const scene = table3D && table3D._scene;
  const camera = table3D && table3D._camera;
  const renderer = table3D && table3D._renderer;

  // --- 時間制御
  let hitStopLeft = 0;
  let slowLeft = 0;
  let slowTotal = 0;
  let slowScale = 1;
  let vfxClock = 0;          // 演出用の「ゲーム内時間」(秒)
  let realClock = 0;

  // --- ポストプロセス
  let bloom = null;
  let fxPass = null;
  let flashLeft = 0, flashDur = 0, flashStrength = 0;
  let aberration = 0;
  let bloomBase = 0.30;
  let bloomBoost = 0;

  if (table3D && typeof table3D._registerPass === 'function' && renderer) {
    try {
      const size = new THREE.Vector2();
      renderer.getSize(size);
      bloom = new UnrealBloomPass(new THREE.Vector2(size.x || 1, size.y || 1), bloomBase, 0.6, 0.92);
      table3D._registerPass(bloom);
    } catch (_) { bloom = null; }
    try {
      fxPass = new ShaderPass(FX_SHADER);
      table3D._registerPass(fxPass);
    } catch (_) { fxPass = null; }
  }

  // --- パーティクル（プール / GPU アニメーション）
  let points = null;
  let pGeo = null;
  let pMat = null;
  let cursor = 0;
  let aPos, aVel, aCol, aStart, aLife, aSize;

  if (scene) {
    pGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(PARTICLE_CAP * 3);
    const vel = new Float32Array(PARTICLE_CAP * 3);
    const col = new Float32Array(PARTICLE_CAP * 3);
    const st = new Float32Array(PARTICLE_CAP);
    const lf = new Float32Array(PARTICLE_CAP);
    const sz = new Float32Array(PARTICLE_CAP);
    st.fill(-1000);
    lf.fill(1);
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pGeo.setAttribute('aVel', new THREE.BufferAttribute(vel, 3));
    pGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    pGeo.setAttribute('aStart', new THREE.BufferAttribute(st, 1));
    pGeo.setAttribute('aLife', new THREE.BufferAttribute(lf, 1));
    pGeo.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    aPos = pGeo.attributes.position; aVel = pGeo.attributes.aVel; aCol = pGeo.attributes.aColor;
    aStart = pGeo.attributes.aStart; aLife = pGeo.attributes.aLife; aSize = pGeo.attributes.aSize;

    pMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPR: { value: Math.min(window.devicePixelRatio || 1, 2) },
      },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    points = new THREE.Points(pGeo, pMat);
    points.frustumCulled = false;
    points.renderOrder = 10;
    scene.add(points);
  }

  // --- 衝撃波リング（プール）
  const ringGeo = scene ? new THREE.RingGeometry(0.575, 0.64, 96) : null;
  const rings = [];
  if (scene && ringGeo) {
    for (let i = 0; i < RING_CAP; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(ringGeo, mat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.renderOrder = 9;
      scene.add(m);
      rings.push({ mesh: m, mat, t: 0, dur: 0, active: false, flat: true });
    }
  }

  const tmpColor = new THREE.Color();

  // ---------------------------------------------------------------- API

  function hitStop(ms) {
    const v = Math.max(0, Number(ms) || 0);
    hitStopLeft = Math.max(hitStopLeft, v);
  }

  function slowMotion(ms, scale) {
    const v = Math.max(0, Number(ms) || 0);
    const s = Math.min(1, Math.max(0.02, Number(scale) || 0.25));
    slowLeft = Math.max(slowLeft, v);
    slowTotal = Math.max(slowTotal, v);
    slowScale = s;
  }

  function timeScale() {
    if (hitStopLeft > 0) return 0;
    if (slowLeft > 0) {
      // 終了間際は滑らかに 1.0 へ戻す
      const tail = Math.min(260, slowTotal * 0.5) || 1;
      if (slowLeft < tail) {
        const k = 1 - slowLeft / tail;
        const e = k * k * (3 - 2 * k); // smoothstep
        return slowScale + (1 - slowScale) * e;
      }
      return slowScale;
    }
    return 1;
  }

  function burst(pos, color, count) {
    if (!points) return;
    const p = pos || {};
    const ox = Number(p.x) || 0, oy = Number(p.y) || 0, oz = Number(p.z) || 0;
    const n = Math.max(1, Math.min(600, count | 0 || 40));
    tmpColor.set(color != null ? color : 0x6cf7d2);
    const cr = tmpColor.r, cg = tmpColor.g, cb = tmpColor.b;

    for (let i = 0; i < n; i++) {
      const idx = cursor;
      cursor = (cursor + 1) % PARTICLE_CAP;

      // 半球状に散らす（上方向バイアス）
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(1 - Math.random() * 1.25);
      const sp = 1.8 + Math.random() * 5.4;
      const vx = Math.sin(ph) * Math.cos(th) * sp;
      const vy = Math.abs(Math.cos(ph)) * sp * 1.25 + 0.7;
      const vz = Math.sin(ph) * Math.sin(th) * sp;

      aPos.setXYZ(idx, ox + (Math.random() - 0.5) * 0.12, oy + (Math.random() - 0.5) * 0.12, oz + (Math.random() - 0.5) * 0.12);
      aVel.setXYZ(idx, vx, vy, vz);
      // 火花の色味を少し散らす
      const t = 0.72 + Math.random() * 0.55;
      aCol.setXYZ(idx, Math.min(1.8, cr * t + 0.10), Math.min(1.8, cg * t + 0.10), Math.min(1.8, cb * t + 0.10));
      aStart.setX(idx, vfxClock);
      aLife.setX(idx, 0.55 + Math.random() * 0.85);
      aSize.setX(idx, 0.16 + Math.random() * 0.40);
    }
    aPos.needsUpdate = true; aVel.needsUpdate = true; aCol.needsUpdate = true;
    aStart.needsUpdate = true; aLife.needsUpdate = true; aSize.needsUpdate = true;

    bloomBoost = Math.min(1.1, bloomBoost + 0.22);
  }

  function spawnRing(pos, color, opts) {
    if (!rings.length) return;
    let slot = rings.find((r) => !r.active);
    if (!slot) { slot = rings[0]; }
    const p = pos || {};
    const o = opts || {};
    slot.active = true;
    slot.t = 0;
    slot.dur = o.dur || 0.62;
    slot.from = o.from != null ? o.from : 0.35;
    slot.to = o.to != null ? o.to : 5.2;
    slot.mat.color.set(color != null ? color : 0x8cf9ff);
    slot.mat.opacity = 0.95;
    slot.mesh.visible = true;
    slot.mesh.position.set(Number(p.x) || 0, (Number(p.y) || 0) + 0.02, Number(p.z) || 0);
    slot.mesh.scale.setScalar(slot.from);
    slot.mesh.rotation.x = -Math.PI / 2;
    slot.mesh.rotation.z = Math.random() * Math.PI;
  }

  function shockwave(pos, color) {
    spawnRing(pos, color, { dur: 0.6, from: 0.3, to: 5.4 });
    // 二重リング（少し遅れて）
    spawnRing(pos, color, { dur: 0.85, from: 0.15, to: 3.2 });
    bloomBoost = Math.min(1.2, bloomBoost + 0.3);
  }

  function screenFlash(color, ms) {
    if (!fxPass) return;
    flashDur = Math.max(30, Number(ms) || 140);
    flashLeft = flashDur;
    flashStrength = 0.85;
    fxPass.uniforms.uFlashColor.value.set(color != null ? color : 0xffffff);
  }

  function chromaticPulse(strength) {
    const s = Math.max(0, Math.min(1, Number(strength) || 0.5));
    aberration = Math.max(aberration, s * 0.045);
  }

  // ---------------------------------------------------------------- update

  function update(realDtMs) {
    const realMs = Math.min(120, Math.max(0, Number(realDtMs) || 0));
    const realS = realMs / 1000;
    realClock += realS;

    // タイマーは実時間で進める
    if (hitStopLeft > 0) hitStopLeft = Math.max(0, hitStopLeft - realMs);
    if (slowLeft > 0) {
      slowLeft = Math.max(0, slowLeft - realMs);
      if (slowLeft === 0) slowTotal = 0;
    }

    const ts = timeScale();
    const s = realS * ts;
    vfxClock += s;

    if (pMat) pMat.uniforms.uTime.value = vfxClock;

    // 衝撃波リング
    for (const r of rings) {
      if (!r.active) continue;
      r.t += s;
      const k = Math.min(1, r.t / r.dur);
      const e = 1 - Math.pow(1 - k, 3);
      r.mesh.scale.setScalar(r.from + (r.to - r.from) * e);
      r.mat.opacity = Math.max(0, 0.95 * Math.pow(1 - k, 1.8));
      if (k >= 1) { r.active = false; r.mesh.visible = false; r.mat.opacity = 0; }
    }

    // フラッシュ（実時間で減衰させて「止まった瞬間」も光る）
    if (fxPass) {
      if (flashLeft > 0) {
        flashLeft = Math.max(0, flashLeft - realMs);
        const k = flashLeft / flashDur;
        fxPass.uniforms.uFlash.value = flashStrength * k * k;
      } else {
        fxPass.uniforms.uFlash.value = 0;
      }
      aberration *= Math.exp(-6.5 * realS);
      if (aberration < 0.0002) aberration = 0;
      // ヒットストップ/スロー中はうっすら色収差 + 歪みを足す
      const stress = (hitStopLeft > 0 ? 0.016 : 0) + (slowLeft > 0 ? 0.010 * (1 - ts) : 0);
      fxPass.uniforms.uAberration.value = aberration + stress;
      fxPass.uniforms.uWarp.value = (slowLeft > 0 ? 0.10 * (1 - ts) : 0) + (hitStopLeft > 0 ? 0.08 : 0);
      fxPass.uniforms.uTime.value = realClock;
    }

    if (bloom) {
      bloomBoost *= Math.exp(-3.2 * realS);
      if (bloomBoost < 0.001) bloomBoost = 0;
      bloom.strength = bloomBase + bloomBoost;
    }
  }

  function dispose() {
    if (points && scene) { scene.remove(points); }
    if (pGeo) pGeo.dispose();
    if (pMat) pMat.dispose();
    for (const r of rings) { if (scene) scene.remove(r.mesh); r.mat.dispose(); }
    if (ringGeo) ringGeo.dispose();
    if (bloom && bloom.dispose) { try { bloom.dispose(); } catch (_) {} }
    if (fxPass && fxPass.dispose) { try { fxPass.dispose(); } catch (_) {} }
  }

  if (table3D) table3D._onDispose = dispose;

  return {
    hitStop, timeScale, update, burst, shockwave, slowMotion, screenFlash, chromaticPulse,
    dispose,
    // 追加: 演出プリセット（main.js から手軽に呼べる）
    celebrate(pos, color) {
      burst(pos, color || 0xffd76a, 160);
      shockwave(pos, color || 0xffd76a);
      screenFlash(0xffffff, 120);
      chromaticPulse(0.8);
      hitStop(90);
      slowMotion(520, 0.35);
    },
  };
}
