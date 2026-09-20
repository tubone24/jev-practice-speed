// vfx.js — ヒットストップ / スローモーション / 粒子 / 属性エフェクト(炎・水・雷) / 画面演出 (契約 §5.3)
import * as THREE from 'three';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const PARTICLE_CAP = 7000;
const RING_CAP = 26;
const BOLT_CAP = 5;
const BOLT_SEGS = 20;
const PILLAR_CAP = 4;

/** 粒子モード。頂点シェーダ側で色と減衰の挙動を切り替える */
const MODE = { SPARK: 0, FLAME: 1, WATER: 2, BOLT: 3 };

// ---------------------------------------------------------------- パーティクル shader

const PARTICLE_VS = /* glsl */`
attribute vec3 aVel;
attribute vec3 aColor;
attribute float aStart;
attribute float aLife;
attribute float aSize;
attribute float aGrav;
attribute float aSpin;
attribute float aMode;
uniform float uTime;
uniform float uPR;
varying vec3 vColor;
varying float vAlpha;
varying float vMode;
void main() {
  float age = uTime - aStart;
  float k = age / max(aLife, 0.0001);
  vMode = aMode;
  if (k < 0.0 || k >= 1.0) {
    vAlpha = 0.0;
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  // 簡易物理: 空気抵抗 + 重力(粒子ごと) + 渦(粒子ごと)
  float drag = 1.0 - exp(-1.9 * age);
  vec3 off = aVel * (drag / 1.9);
  if (abs(aSpin) > 0.001) {
    float a = aSpin * age;
    float c = cos(a), s = sin(a);
    off.xz = vec2(off.x * c - off.z * s, off.x * s + off.z * c);
  }
  vec3 p = position + off + vec3(0.0, aGrav, 0.0) * 0.5 * age * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float fade = 1.0 - k;
  float size = aSize;
  vColor = aColor;
  vAlpha = fade * fade;

  if (aMode > 0.5 && aMode < 1.5) {
    // 炎: 黄 → 橙 → 赤 → 煤。上昇しながら膨らみ、細かく明滅する
    vColor = mix(aColor, vec3(1.0, 0.22, 0.02), k * k);
    vColor = mix(vColor, vec3(0.16, 0.04, 0.03), smoothstep(0.62, 1.0, k));
    float flick = 0.70 + 0.30 * sin(age * 46.0 + aStart * 31.0);
    vAlpha = fade * flick;
    size *= 1.0 + k * 2.2;
  } else if (aMode > 1.5 && aMode < 2.5) {
    // 水: 芯は青、飛沫の先端で白く泡立つ
    vColor = mix(aColor, vec3(0.86, 0.98, 1.0), smoothstep(0.0, 0.40, k));
    vAlpha = fade * fade * 1.25;
    size *= 1.0 - 0.45 * k;
  } else if (aMode > 2.5) {
    // 雷: 高速で明滅する白青の火花
    float flick = step(0.32, fract(sin(aStart * 97.0 + floor(age * 70.0) * 13.13) * 43758.5453));
    vColor = mix(aColor, vec3(1.0), 0.55);
    vAlpha = fade * (0.28 + 0.72 * flick);
    size *= 1.0 + 0.5 * sin(age * 90.0);
  }

  float dist = max(-mv.z, 0.001);
  gl_PointSize = clamp(size * uPR * (330.0 / dist) * (0.4 + 0.6 * fade), 1.0, 190.0);
}
`;

const PARTICLE_FS = /* glsl */`
varying vec3 vColor;
varying float vAlpha;
varying float vMode;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d) * 4.0;
  if (r > 1.0) discard;
  // 炎は輪郭を柔らかく、雷は芯を締める
  float p = (vMode > 0.5 && vMode < 1.5) ? 1.1 : (vMode > 2.5 ? 2.6 : 1.7);
  float a = pow(1.0 - r, p) * vAlpha;
  gl_FragColor = vec4(vColor * (1.0 + 1.4 * (1.0 - r)), a);
}
`;

// ---------------------------------------------------------------- 稲妻リボン shader

const BOLT_FS = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
void main() {
  float e = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float a = pow(max(e, 0.0), 1.5) * uOpacity;
  gl_FragColor = vec4(uColor * (1.0 + 2.6 * e), a);
}
`;

const BOLT_VS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

// ---------------------------------------------------------------- 光柱 shader

const PILLAR_FS = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;
void main() {
  // 下は濃く、上へ向かって溶ける
  float v = 1.0 - vUv.y;
  float band = 0.55 + 0.45 * sin(vUv.y * 22.0 - uTime * 9.0);
  float a = pow(v, 1.7) * uOpacity * (0.55 + 0.45 * band);
  // 円筒の縁を明るく（内側からの発光に見せる）
  float edge = pow(abs(sin(vUv.x * 3.14159)), 0.5);
  gl_FragColor = vec4(uColor * (1.2 + 1.8 * v), a * (0.35 + 0.65 * edge));
}
`;

// ---------------------------------------------------------------- 画面演出パス

const FX_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uAberration: { value: 0.0 },
    uFlashColor: { value: new THREE.Color(0xffffff) },
    uFlash: { value: 0.0 },
    uVignette: { value: 0.32 },
    uTime: { value: 0.0 },
    uWarp: { value: 0.0 },
    uRadial: { value: 0.0 },   // 放射ブラー（集中線）
    uTint: { value: new THREE.Color(0x000000) },
    uTintAmt: { value: 0.0 },  // コンボ帯の常時色被り
    uPulse: { value: 0.0 },    // 縁の脈動
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
    uniform float uRadial;
    uniform vec3 uTint;
    uniform float uTintAmt;
    uniform float uPulse;
    varying vec2 vUv;

    vec3 sampleShift(vec2 uv, vec2 off) {
      return vec3(
        texture2D(tDiffuse, uv + off).r,
        texture2D(tDiffuse, uv).g,
        texture2D(tDiffuse, uv - off).b
      );
    }

    void main() {
      vec2 c = vUv - 0.5;
      float d = length(c);
      // レンズ歪み（スロー/ヒットストップ中に微かに効かせる）
      vec2 uvw = vUv + c * d * d * uWarp;
      vec2 off = c * uAberration * (0.35 + d);

      vec3 col;
      if (uRadial > 0.0005) {
        // 中心へ向かう多段サンプル = 集中線 / ズームブラー
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 6; i++) {
          float t = float(i) / 5.0;
          vec2 uv2 = uvw - c * uRadial * t * (0.25 + d);
          acc += sampleShift(uv2, off * (1.0 + t));
        }
        col = acc / 6.0;
      } else {
        col = sampleShift(uvw, off);
      }

      // 走査ノイズ（色収差が強い時だけ）
      if (uAberration > 0.0005) {
        float n = fract(sin((vUv.y * 431.0 + uTime * 7.0)) * 43758.5453);
        col += (n - 0.5) * uAberration * 2.2;
      }
      // コンボ帯の色被り。盤面中央には乗せず、画面の縁だけを染める
      if (uTintAmt > 0.001) {
        col = mix(col, col * 0.72 + uTint * 0.85, uTintAmt * smoothstep(0.30, 0.86, d));
        col += uTint * uPulse * smoothstep(0.38, 0.92, d);
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
  let radial = 0;
  let bloomBase = 0.30;
  let bloomBoost = 0;

  // --- コンボ帯（rage）。0..1 で常時演出の強さを決める
  let rage = 0;
  let rageTarget = 0;
  const rageColor = new THREE.Color(0x000000);
  const rageColorTarget = new THREE.Color(0x000000);

  // --- 緊張（tension）。残り枚数が少ないときの「死にかけ」演出。心拍で脈打つ
  let tension = 0;
  let tensionTarget = 0;
  let tensionHz = 1.1;
  const tensionColor = new THREE.Color(0x000000);
  const tensionColorTarget = new THREE.Color(0x000000);

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
  let aPos, aVel, aCol, aStart, aLife, aSize, aGrav, aSpin, aMode;
  let dirty = false;

  if (scene) {
    pGeo = new THREE.BufferGeometry();
    const f3 = () => new Float32Array(PARTICLE_CAP * 3);
    const f1 = () => new Float32Array(PARTICLE_CAP);
    const st = f1();
    const lf = f1();
    st.fill(-1000);
    lf.fill(1);
    pGeo.setAttribute('position', new THREE.BufferAttribute(f3(), 3));
    pGeo.setAttribute('aVel', new THREE.BufferAttribute(f3(), 3));
    pGeo.setAttribute('aColor', new THREE.BufferAttribute(f3(), 3));
    pGeo.setAttribute('aStart', new THREE.BufferAttribute(st, 1));
    pGeo.setAttribute('aLife', new THREE.BufferAttribute(lf, 1));
    pGeo.setAttribute('aSize', new THREE.BufferAttribute(f1(), 1));
    pGeo.setAttribute('aGrav', new THREE.BufferAttribute(f1(), 1));
    pGeo.setAttribute('aSpin', new THREE.BufferAttribute(f1(), 1));
    pGeo.setAttribute('aMode', new THREE.BufferAttribute(f1(), 1));
    aPos = pGeo.attributes.position; aVel = pGeo.attributes.aVel; aCol = pGeo.attributes.aColor;
    aStart = pGeo.attributes.aStart; aLife = pGeo.attributes.aLife; aSize = pGeo.attributes.aSize;
    aGrav = pGeo.attributes.aGrav; aSpin = pGeo.attributes.aSpin; aMode = pGeo.attributes.aMode;

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

  const tmpColor = new THREE.Color();
  const tmpVec = new THREE.Vector3();

  /** 粒子を 1 個プールに書き込む。呼び出し側は最後に flushParticles() すること */
  function push(px, py, pz, vx, vy, vz, r, g, b, life, size, grav, spin, mode) {
    const i = cursor;
    cursor = (cursor + 1) % PARTICLE_CAP;
    aPos.setXYZ(i, px, py, pz);
    aVel.setXYZ(i, vx, vy, vz);
    aCol.setXYZ(i, r, g, b);
    aStart.setX(i, vfxClock);
    aLife.setX(i, life);
    aSize.setX(i, size);
    aGrav.setX(i, grav);
    aSpin.setX(i, spin);
    aMode.setX(i, mode);
    dirty = true;
  }

  function flushParticles() {
    if (!dirty) return;
    aPos.needsUpdate = true; aVel.needsUpdate = true; aCol.needsUpdate = true;
    aStart.needsUpdate = true; aLife.needsUpdate = true; aSize.needsUpdate = true;
    aGrav.needsUpdate = true; aSpin.needsUpdate = true; aMode.needsUpdate = true;
    dirty = false;
  }

  const xyz = (p) => [Number(p && p.x) || 0, Number(p && p.y) || 0, Number(p && p.z) || 0];

  // --- 衝撃波リング（プール）。水平にも、カメラ正対にも置ける
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
      rings.push({ mesh: m, mat, t: 0, dur: 0, active: false, billboard: false, from: 0.3, to: 5 });
    }
  }

  // --- 稲妻リボン（プール）
  const bolts = [];
  if (scene) {
    const idx = [];
    for (let i = 0; i < BOLT_SEGS; i++) {
      const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
      idx.push(a, b, c, b, d, c);
    }
    for (let n = 0; n < BOLT_CAP; n++) {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array((BOLT_SEGS + 1) * 2 * 3);
      const uv = new Float32Array((BOLT_SEGS + 1) * 2 * 2);
      for (let i = 0; i <= BOLT_SEGS; i++) {
        const t = i / BOLT_SEGS;
        uv[(i * 2) * 2] = 0; uv[(i * 2) * 2 + 1] = t;
        uv[(i * 2 + 1) * 2] = 1; uv[(i * 2 + 1) * 2 + 1] = t;
      }
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(0xbfe9ff) }, uOpacity: { value: 0 } },
        vertexShader: BOLT_VS, fragmentShader: BOLT_FS,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 11;
      scene.add(mesh);
      bolts.push({ mesh, geo: g, mat, t: 0, dur: 0, active: false });
    }
  }

  // --- 光柱（プール）
  const pillarGeo = scene ? new THREE.CylinderGeometry(0.62, 1.05, 6.4, 28, 1, true) : null;
  const pillars = [];
  if (scene && pillarGeo) {
    pillarGeo.translate(0, 3.2, 0);
    for (let i = 0; i < PILLAR_CAP; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(0xffa23a) },
          uOpacity: { value: 0 },
          uTime: { value: 0 },
        },
        vertexShader: BOLT_VS, fragmentShader: PILLAR_FS,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const m = new THREE.Mesh(pillarGeo, mat);
      m.visible = false;
      m.renderOrder = 8;
      scene.add(m);
      pillars.push({ mesh: m, mat, t: 0, dur: 0, active: false });
    }
  }

  // --- 属性フラッシュ用のライト（数を固定してシェーダ再コンパイルを避ける）
  const fxLights = [];
  if (scene) {
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 18, 1.9);
      l.position.set(0, 1.2, 0);
      scene.add(l);
      fxLights.push({ light: l, t: 0, dur: 0, peak: 0, active: false });
    }
  }

  function flashLight(pos, color, peak, dur) {
    if (!fxLights.length) return;
    let slot = fxLights.find((f) => !f.active) || fxLights[0];
    const [x, y, z] = xyz(pos);
    slot.light.position.set(x, y + 0.9, z);
    slot.light.color.set(color);
    slot.peak = peak;
    slot.dur = dur;
    slot.t = 0;
    slot.active = true;
  }

  // ---------------------------------------------------------------- 時間制御 API

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

  // ---------------------------------------------------------------- 粒子 API

  function burst(pos, color, count) {
    if (!points) return;
    const [ox, oy, oz] = xyz(pos);
    const n = Math.max(1, Math.min(900, count | 0 || 40));
    tmpColor.set(color != null ? color : 0x6cf7d2);
    const cr = tmpColor.r, cg = tmpColor.g, cb = tmpColor.b;

    for (let i = 0; i < n; i++) {
      // 半球状に散らす（上方向バイアス）
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(1 - Math.random() * 1.25);
      const sp = 1.8 + Math.random() * 5.4;
      const t = 0.72 + Math.random() * 0.55;
      push(
        ox + (Math.random() - 0.5) * 0.12, oy + (Math.random() - 0.5) * 0.12, oz + (Math.random() - 0.5) * 0.12,
        Math.sin(ph) * Math.cos(th) * sp, Math.abs(Math.cos(ph)) * sp * 1.25 + 0.7, Math.sin(ph) * Math.sin(th) * sp,
        Math.min(1.8, cr * t + 0.10), Math.min(1.8, cg * t + 0.10), Math.min(1.8, cb * t + 0.10),
        0.55 + Math.random() * 0.85, 0.16 + Math.random() * 0.40,
        -3.4, 0, MODE.SPARK,
      );
    }
    flushParticles();
    bloomBoost = Math.min(1.1, bloomBoost + 0.22);
  }

  /** 炎: 上へ加速しながら膨らむ火柱。coreColor は芯の色 */
  function flame(pos, count, opts) {
    if (!points) return;
    const o = opts || {};
    const [ox, oy, oz] = xyz(pos);
    const n = Math.max(1, Math.min(900, count | 0 || 90));
    const radius = o.radius != null ? o.radius : 0.42;
    const rise = o.rise != null ? o.rise : 3.1;
    const swirl = o.swirl != null ? o.swirl : 2.2;
    tmpColor.set(o.color != null ? o.color : 0xffd36a);

    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const rr = Math.pow(Math.random(), 0.65) * radius;
      const up = rise * (0.55 + Math.random() * 0.95);
      const t = 0.85 + Math.random() * 0.4;
      push(
        ox + Math.cos(th) * rr, oy + Math.random() * 0.18, oz + Math.sin(th) * rr,
        Math.cos(th) * (0.25 + Math.random() * 0.7), up, Math.sin(th) * (0.25 + Math.random() * 0.7),
        Math.min(2.2, tmpColor.r * t + 0.25), Math.min(2.0, tmpColor.g * t * 0.85), Math.min(1.4, tmpColor.b * t * 0.5),
        0.65 + Math.random() * 0.75, 0.22 + Math.random() * 0.46,
        1.9, (Math.random() - 0.5) * swirl, MODE.FLAME,
      );
    }
    flushParticles();
    bloomBoost = Math.min(1.4, bloomBoost + 0.26);
    flashLight(pos, 0xff7a1e, 26, 420);
  }

  /** 水: 高く上げて重力で落ちる飛沫 */
  function water(pos, count, opts) {
    if (!points) return;
    const o = opts || {};
    const [ox, oy, oz] = xyz(pos);
    const n = Math.max(1, Math.min(900, count | 0 || 120));
    const power = o.power != null ? o.power : 1;
    tmpColor.set(o.color != null ? o.color : 0x4fd4ff);

    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const lift = (3.6 + Math.random() * 4.6) * power;
      const out = (0.6 + Math.random() * 3.4) * power;
      const t = 0.8 + Math.random() * 0.5;
      push(
        ox + (Math.random() - 0.5) * 0.3, oy + Math.random() * 0.1, oz + (Math.random() - 0.5) * 0.3,
        Math.cos(th) * out, lift, Math.sin(th) * out,
        tmpColor.r * t * 0.7, tmpColor.g * t, Math.min(2.0, tmpColor.b * t + 0.3),
        0.75 + Math.random() * 0.75, 0.13 + Math.random() * 0.30,
        -11.5, 0, MODE.WATER,
      );
    }
    flushParticles();
    bloomBoost = Math.min(1.2, bloomBoost + 0.2);
    flashLight(pos, 0x2ea8ff, 20, 340);
  }

  /** 渦: 接線方向に撃ち出して回転させる。属性演出の土台 */
  function vortex(pos, color, count, opts) {
    if (!points) return;
    const o = opts || {};
    const [ox, oy, oz] = xyz(pos);
    const n = Math.max(1, Math.min(900, count | 0 || 80));
    tmpColor.set(color != null ? color : 0xa78bfa);
    const spin = o.spin != null ? o.spin : 5.5;

    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const rr = 0.5 + Math.random() * 1.5;
      const t = 0.8 + Math.random() * 0.5;
      push(
        ox + Math.cos(th) * rr * 0.4, oy + Math.random() * 0.4, oz + Math.sin(th) * rr * 0.4,
        Math.cos(th) * rr, 2.2 + Math.random() * 3.4, Math.sin(th) * rr,
        tmpColor.r * t, tmpColor.g * t, tmpColor.b * t,
        0.8 + Math.random() * 0.7, 0.14 + Math.random() * 0.3,
        -0.9, spin * (0.7 + Math.random() * 0.6), MODE.SPARK,
      );
    }
    flushParticles();
  }

  // ---------------------------------------------------------------- リング / 稲妻 / 光柱

  function spawnRing(pos, color, opts) {
    if (!rings.length) return;
    const slot = rings.find((r) => !r.active) || rings[0];
    const [x, y, z] = xyz(pos);
    const o = opts || {};
    slot.active = true;
    slot.t = 0;
    slot.dur = o.dur || 0.62;
    slot.from = o.from != null ? o.from : 0.35;
    slot.to = o.to != null ? o.to : 5.2;
    slot.peak = o.opacity != null ? o.opacity : 0.95;
    slot.billboard = !!o.billboard;
    slot.mat.color.set(color != null ? color : 0x8cf9ff);
    slot.mat.opacity = slot.peak;
    slot.mesh.visible = true;
    slot.mesh.position.set(x, y + 0.02, z);
    slot.mesh.scale.setScalar(slot.from);
    if (slot.billboard && camera) {
      slot.mesh.quaternion.copy(camera.quaternion);
    } else {
      slot.mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI);
    }
  }

  function shockwave(pos, color) {
    spawnRing(pos, color, { dur: 0.6, from: 0.3, to: 5.4 });
    // 二重リング（少し遅れて）
    spawnRing(pos, color, { dur: 0.85, from: 0.15, to: 3.2 });
    bloomBoost = Math.min(1.2, bloomBoost + 0.3);
  }

  /** 落雷。空から pos へ一本、枝分かれの火花つき */
  function lightning(pos, color, opts) {
    const o = opts || {};
    const [tx, ty, tz] = xyz(pos);
    const col = color != null ? color : 0xcfe9ff;

    if (bolts.length) {
      const slot = bolts.find((b) => !b.active) || bolts[0];
      const topY = o.height != null ? o.height : 9.2;
      const sx = tx + (Math.random() - 0.5) * 2.6;
      const sz = tz + (Math.random() - 0.5) * 2.0;
      const halfW = (o.width != null ? o.width : 0.085) * 0.5;

      // カメラ右方向をリボンの幅方向に使う（正面から常に太く見える）
      let rx = 1, rz = 0;
      if (camera) {
        camera.getWorldDirection(tmpVec);
        const len = Math.hypot(tmpVec.z, -tmpVec.x) || 1;
        rx = tmpVec.z / len; rz = -tmpVec.x / len;
      }

      const arr = slot.geo.attributes.position.array;
      let jx = 0, jz = 0;
      for (let i = 0; i <= BOLT_SEGS; i++) {
        const t = i / BOLT_SEGS;
        const e = t * t;                       // 落下点に近いほど直線的に
        jx += (Math.random() - 0.5) * 0.75 * (1 - e);
        jz += (Math.random() - 0.5) * 0.55 * (1 - e);
        const px = sx + (tx - sx) * t + jx * (1 - e);
        const py = topY + (ty - topY) * t;
        const pz = sz + (tz - sz) * t + jz * (1 - e);
        const w = halfW * (1.6 - 1.1 * t);
        const a = i * 2 * 3, b = a + 3;
        arr[a] = px - rx * w; arr[a + 1] = py; arr[a + 2] = pz - rz * w;
        arr[b] = px + rx * w; arr[b + 1] = py; arr[b + 2] = pz + rz * w;
      }
      slot.geo.attributes.position.needsUpdate = true;
      slot.geo.computeBoundingSphere();
      slot.mat.uniforms.uColor.value.set(col);
      slot.mat.uniforms.uOpacity.value = 1;
      slot.mesh.visible = true;
      slot.active = true;
      slot.t = 0;
      slot.dur = o.dur != null ? o.dur : 0.30;
    }

    // 着弾点の火花と輪
    if (points) {
      tmpColor.set(col);
      const n = o.sparks != null ? o.sparks : 70;
      for (let i = 0; i < n; i++) {
        const th = Math.random() * Math.PI * 2;
        const sp = 2.5 + Math.random() * 7.5;
        push(
          tx, ty + 0.05, tz,
          Math.cos(th) * sp, Math.random() * 3.6, Math.sin(th) * sp,
          tmpColor.r, tmpColor.g, Math.min(2.0, tmpColor.b + 0.3),
          0.35 + Math.random() * 0.5, 0.12 + Math.random() * 0.28,
          -6.5, 0, MODE.BOLT,
        );
      }
      flushParticles();
    }
    spawnRing(pos, col, { dur: 0.45, from: 0.2, to: 4.4, opacity: 1 });
    flashLight(pos, 0xdfefff, 42, 240);
    bloomBoost = Math.min(1.6, bloomBoost + 0.45);
  }

  /** 光柱。属性の「決めカット」用 */
  function pillar(pos, color, opts) {
    if (!pillars.length) return;
    const o = opts || {};
    const slot = pillars.find((p) => !p.active) || pillars[0];
    const [x, y, z] = xyz(pos);
    slot.mat.uniforms.uColor.value.set(color != null ? color : 0xffb347);
    slot.mat.uniforms.uOpacity.value = 0;
    slot.peak = o.opacity != null ? o.opacity : 0.85;
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.set(o.scale != null ? o.scale : 1, o.height != null ? o.height : 1, o.scale != null ? o.scale : 1);
    slot.mesh.visible = true;
    slot.active = true;
    slot.t = 0;
    slot.dur = o.dur != null ? o.dur : 0.9;
    bloomBoost = Math.min(1.5, bloomBoost + 0.3);
  }

  // ---------------------------------------------------------------- 画面

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

  /** 集中線（放射ブラー）。0..1 */
  function radialBlast(strength) {
    const s = Math.max(0, Math.min(1, Number(strength) || 0.5));
    radial = Math.max(radial, s * 0.13);
  }

  /**
   * コンボ帯の常時演出。level 0..1、color は画面周辺の色被り。
   * 高いほど bloom・色収差・周辺の脈動が上がり、画面が「熱く」なる。
   */
  function setRage(level, color) {
    rageTarget = Math.max(0, Math.min(1, Number(level) || 0));
    rageColorTarget.set(color != null ? color : 0x000000);
  }

  /**
   * 残り枚数が少ないときの緊張。level 0..1、hz は心拍の速さ。
   * rage と違い、脈打つたびに画面の縁が締まって視界が狭くなる（＝死にかけ）。
   */
  function setTension(level, color, hz) {
    tensionTarget = Math.max(0, Math.min(1, Number(level) || 0));
    tensionColorTarget.set(color != null ? color : 0x000000);
    tensionHz = Math.max(0.3, Math.min(4.5, Number(hz) || 1.1));
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
      r.mat.opacity = Math.max(0, (r.peak || 0.95) * Math.pow(1 - k, 1.8));
      if (r.billboard && camera) r.mesh.quaternion.copy(camera.quaternion);
      if (k >= 1) { r.active = false; r.mesh.visible = false; r.mat.opacity = 0; }
    }

    // 稲妻（実時間で明滅させて、ヒットストップ中も走らせる）
    for (const b of bolts) {
      if (!b.active) continue;
      b.t += realS;
      const k = Math.min(1, b.t / b.dur);
      const flick = k < 0.55 ? (Math.random() < 0.22 ? 0.25 : 1) : 1;
      b.mat.uniforms.uOpacity.value = Math.max(0, Math.pow(1 - k, 1.5)) * flick;
      if (k >= 1) { b.active = false; b.mesh.visible = false; b.mat.uniforms.uOpacity.value = 0; }
    }

    // 光柱
    for (const p of pillars) {
      if (!p.active) continue;
      p.t += s;
      const k = Math.min(1, p.t / p.dur);
      const rise = Math.min(1, k / 0.18);
      p.mat.uniforms.uTime.value = vfxClock;
      p.mat.uniforms.uOpacity.value = (p.peak || 0.85) * rise * Math.pow(1 - k, 1.6);
      p.mesh.scale.x = p.mesh.scale.z = (0.6 + 0.4 * rise) * (1 + k * 0.5);
      if (k >= 1) { p.active = false; p.mesh.visible = false; p.mat.uniforms.uOpacity.value = 0; }
    }

    // 属性ライト
    for (const f of fxLights) {
      if (!f.active) continue;
      f.t += realMs;
      const k = Math.min(1, f.t / f.dur);
      f.light.intensity = f.peak * Math.pow(1 - k, 2.2);
      if (k >= 1) { f.active = false; f.light.intensity = 0; }
    }

    // コンボ帯の追従（急に上がり、ゆっくり冷める）
    const rateUp = 1 - Math.exp(-7.0 * realS);
    const rateDown = 1 - Math.exp(-2.2 * realS);
    rage += (rageTarget - rage) * (rageTarget > rage ? rateUp : rateDown);
    rageColor.lerp(rageColorTarget, rateUp);

    // 緊張の追従と心拍。ドクン、ドクンと二拍で来る
    tension += (tensionTarget - tension) * (1 - Math.exp(-2.6 * realS));
    tensionColor.lerp(tensionColorTarget, rateUp);
    let beat = 0;
    if (tension > 0.01) {
      const ph = (realClock * tensionHz) % 1;
      // 主拍(0.00) と 副拍(0.30) の 2 発
      const hit = (p, w) => Math.max(0, 1 - Math.abs(p) / w);
      beat = Math.pow(Math.max(hit(ph, 0.14), hit(ph - 0.30, 0.10) * 0.7, hit(ph - 1, 0.14)), 2);
    }
    const beatAmt = tension * beat;

    // 画面の熱 = コンボと緊張の強い方
    const heat = Math.max(rage, tension);
    const heatColor = rage >= tension ? rageColor : tensionColor;

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
      radial *= Math.exp(-4.2 * realS);
      if (radial < 0.0004) radial = 0;

      // ヒットストップ/スロー/コンボ帯/緊張でうっすら色収差 + 歪みを足す
      const stress = (hitStopLeft > 0 ? 0.016 : 0) + (slowLeft > 0 ? 0.010 * (1 - ts) : 0)
        + rage * 0.006 + beatAmt * 0.012;
      fxPass.uniforms.uAberration.value = aberration + stress;
      fxPass.uniforms.uWarp.value = (slowLeft > 0 ? 0.10 * (1 - ts) : 0) + (hitStopLeft > 0 ? 0.08 : 0)
        + rage * 0.05 + beatAmt * 0.06;
      fxPass.uniforms.uRadial.value = radial + rage * 0.012 + beatAmt * 0.010;
      fxPass.uniforms.uTint.value.copy(heatColor);
      fxPass.uniforms.uTintAmt.value = heat * 0.42 + beatAmt * 0.26;
      fxPass.uniforms.uPulse.value = rage * (0.05 + 0.05 * Math.sin(realClock * 9.5)) + beatAmt * 0.16;
      // 心拍のたびに視界が締まる
      fxPass.uniforms.uVignette.value = 0.32 + heat * 0.24 + tension * 0.16 + beatAmt * 0.34;
      fxPass.uniforms.uTime.value = realClock;
    }

    if (bloom) {
      bloomBoost *= Math.exp(-3.2 * realS);
      if (bloomBoost < 0.001) bloomBoost = 0;
      bloom.strength = bloomBase + bloomBoost + rage * 0.16 + beatAmt * 0.12;
    }
  }

  function dispose() {
    if (points && scene) scene.remove(points);
    if (pGeo) pGeo.dispose();
    if (pMat) pMat.dispose();
    for (const r of rings) { if (scene) scene.remove(r.mesh); r.mat.dispose(); }
    if (ringGeo) ringGeo.dispose();
    for (const b of bolts) { if (scene) scene.remove(b.mesh); b.geo.dispose(); b.mat.dispose(); }
    for (const p of pillars) { if (scene) scene.remove(p.mesh); p.mat.dispose(); }
    if (pillarGeo) pillarGeo.dispose();
    for (const f of fxLights) { if (scene) scene.remove(f.light); }
    if (bloom && bloom.dispose) { try { bloom.dispose(); } catch (_) {} }
    if (fxPass && fxPass.dispose) { try { fxPass.dispose(); } catch (_) {} }
  }

  if (table3D) table3D._onDispose = dispose;

  // ---------------------------------------------------------------- プリセット

  /**
   * コンボ段階の演出。tier は 0(通常) 〜 4(極限)。
   * 1 以上で属性(水 → 炎 → 雷 → 全部)を重ねていく。
   */
  function comboSurge(tier, pos, color) {
    const t = Math.max(0, Math.min(4, tier | 0));
    if (t <= 0) return;

    if (t === 1) {                         // 水
      water(pos, 150, { color: 0x4fd4ff, power: 1.05 });
      spawnRing(pos, 0x7fe6ff, { dur: 0.75, from: 0.2, to: 6.0 });
      chromaticPulse(0.5);
    } else if (t === 2) {                  // 炎
      flame(pos, 210, { color: 0xffd36a, radius: 0.5, rise: 3.6 });
      pillar(pos, 0xff8a2b, { dur: 0.85, height: 0.85, opacity: 0.8 });
      spawnRing(pos, 0xff9a3c, { dur: 0.7, from: 0.25, to: 6.4 });
      chromaticPulse(0.7);
      hitStop(55);
    } else if (t === 3) {                  // 雷
      lightning(pos, 0xd8f0ff, { sparks: 110 });
      flame(pos, 140, { color: 0xffe08a, radius: 0.45, rise: 3.2 });
      vortex(pos, 0x9fd8ff, 110, { spin: 7 });
      spawnRing(pos, 0xffffff, { dur: 0.5, from: 0.2, to: 7.0, billboard: true, opacity: 0.8 });
      screenFlash(0xbfe6ff, 110);
      chromaticPulse(0.9);
      hitStop(85);
      slowMotion(380, 0.42);
    } else {                               // 極限: 全部乗せ
      lightning(pos, 0xffffff, { sparks: 140, width: 0.12 });
      lightning({ x: (pos && pos.x || 0) - 1.4, y: pos && pos.y || 0, z: pos && pos.z || 0 }, 0xa8e2ff, { sparks: 50 });
      lightning({ x: (pos && pos.x || 0) + 1.4, y: pos && pos.y || 0, z: pos && pos.z || 0 }, 0xa8e2ff, { sparks: 50 });
      flame(pos, 280, { color: 0xfff0a0, radius: 0.62, rise: 4.4, swirl: 3.4 });
      water(pos, 160, { color: 0x6fe4ff, power: 1.3 });
      pillar(pos, 0xffd27a, { dur: 1.15, height: 1.25, opacity: 1 });
      vortex(pos, 0xffc36a, 160, { spin: 9 });
      spawnRing(pos, 0xffffff, { dur: 0.55, from: 0.2, to: 8.4, billboard: true, opacity: 1 });
      shockwave(pos, 0xffd27a);
      screenFlash(0xffffff, 150);
      chromaticPulse(1);
      radialBlast(0.7);
      hitStop(120);
      slowMotion(620, 0.3);
    }
  }

  /**
   * フィニッシュ。「バチコーン」——止める・白飛ばす・引き裂く・降らせる。
   * 実時間で段階的に撃つので、ヒットストップ中も演出は進む。
   */
  function finishBlast(pos, color, opts) {
    const o = opts || {};
    const col = color != null ? color : 0xffd76a;
    const [x, y, z] = xyz(pos);
    const at = { x, y, z };

    // --- 第1撃: 完全停止 + 白飛び + 引き裂き
    hitStop(260);
    screenFlash(0xffffff, 420);
    chromaticPulse(1);
    radialBlast(1);
    slowMotion(2600, 0.16);

    lightning(at, 0xffffff, { sparks: 180, width: 0.16, dur: 0.42 });
    burst(at, 0xffffff, 260);
    shockwave(at, 0xffffff);
    spawnRing(at, 0xffffff, { dur: 0.7, from: 0.2, to: 11.0, billboard: true, opacity: 1 });
    spawnRing(at, col, { dur: 1.0, from: 0.2, to: 9.0, opacity: 1 });
    pillar(at, col, { dur: 1.6, height: 1.8, opacity: 1 });
    flashLight(at, 0xffffff, 80, 500);

    // --- 追撃: 実時間で畳みかける
    const salvo = [
      [90, () => { lightning({ x: x - 2.2, y, z: z - 0.6 }, 0xcfe9ff, { sparks: 70 }); radialBlast(0.6); }],
      [150, () => { flame(at, 320, { color: 0xffe08a, radius: 0.7, rise: 5.2, swirl: 4 }); }],
      [210, () => { lightning({ x: x + 2.4, y, z: z + 0.5 }, 0xcfe9ff, { sparks: 70 }); chromaticPulse(0.8); }],
      [280, () => { water(at, 260, { color: 0x6fe4ff, power: 1.5 }); shockwave(at, col); }],
      [380, () => { vortex(at, col, 220, { spin: 10 }); screenFlash(col, 180); }],
      [520, () => { burst({ x: x - 3.0, y: y + 0.5, z }, 0x5eead4, 160); spawnRing({ x: x - 3.0, y, z }, 0x5eead4, { dur: 0.8, to: 6 }); }],
      [640, () => { burst({ x: x + 3.0, y: y + 0.5, z }, 0xf472b6, 160); spawnRing({ x: x + 3.0, y, z }, 0xf472b6, { dur: 0.8, to: 6 }); }],
      [800, () => { pillar(at, 0xffffff, { dur: 1.4, height: 1.5, opacity: 0.9 }); radialBlast(0.5); }],
      [980, () => { lightning(at, 0xffffff, { sparks: 120, width: 0.13 }); screenFlash(0xffffff, 200); }],
    ];
    const timers = salvo.map(([ms, fn]) => setTimeout(fn, ms));

    // --- 紙吹雪（勝者の色で降らせる）
    const confettiTimers = [];
    if (points && o.confetti !== false) {
      for (let w = 0; w < 7; w++) {
        confettiTimers.push(setTimeout(() => {
          for (let i = 0; i < 90; i++) {
            const c = i % 3 === 0 ? 0xffffff : col;
            tmpColor.set(c);
            push(
              (Math.random() - 0.5) * 11, 7.5 + Math.random() * 2.5, (Math.random() - 0.5) * 6,
              (Math.random() - 0.5) * 2.2, -0.6 - Math.random() * 1.4, (Math.random() - 0.5) * 2.2,
              tmpColor.r, tmpColor.g, tmpColor.b,
              2.2 + Math.random() * 1.4, 0.16 + Math.random() * 0.24,
              -1.6, (Math.random() - 0.5) * 6, MODE.SPARK,
            );
          }
          flushParticles();
        }, 300 + w * 260));
      }
    }
    return () => { for (const t of timers.concat(confettiTimers)) clearTimeout(t); };
  }

  return {
    // --- 契約 §5.3
    hitStop, timeScale, update, burst, shockwave, slowMotion, screenFlash, chromaticPulse,
    dispose,
    // --- 追加（追加のみ・既存シグネチャは不変）
    flame, water, lightning, vortex, pillar, spawnRing, radialBlast, setRage, setTension,
    comboSurge, finishBlast,
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
