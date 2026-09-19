// render3d.js — Three.js 3D テーブル描画 (契約 §5.2)
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { getCardTexture, getBackTexture, preloadAll, setRendererCaps, disposeAll } from './card-texture.js';

// ---------------------------------------------------------------- 定数

const CARD_W = 1.0;
const CARD_H = 1.4;
const CARD_T = 0.035;
const CARD_R = 0.085;          // 角丸半径
const TABLE_Y = 0;
const REST_Y = TABLE_Y + CARD_T / 2 + 0.002;

const HAND_Z = 3.05;
const CPU_Z = -3.05;
const PILE_Z = -0.05;
const PILE_X = 1.02;
const STOCK_HUMAN = { x: 3.35, z: 2.25 };
const STOCK_CPU = { x: -3.35, z: -2.25 };

const HOVER_LIFT = 0.34;
const SEL_LIFT = 0.66;

// ---------------------------------------------------------------- easing

const ease = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outQuint: (t) => 1 - Math.pow(1 - t, 5),
  inOutQuart: (t) => (t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2),
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outElastic: (t) => {
    if (t === 0 || t === 1) return t;
    const c4 = (2 * Math.PI) / 3;
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
  },
  outBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

const damp = (cur, target, lambda, dt) => cur + (target - cur) * (1 - Math.exp(-lambda * dt));

// ---------------------------------------------------------------- 角丸ジオメトリ

function roundedShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** ShapeGeometry の UV を 0..1 に貼り直す */
function fixShapeUV(geo, w, h) {
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
  }
  uv.needsUpdate = true;
  return geo;
}

// ---------------------------------------------------------------- プロシージャル素材

function feltTexture() {
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  // ベース: 深緑 -> 濃紺のグラデーション
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, '#0f3d2e');
  g.addColorStop(0.45, '#0d3b44');
  g.addColorStop(1, '#0a1b3c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // 中央を明るく
  const rg = ctx.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.55);
  rg.addColorStop(0, 'rgba(90,220,170,0.22)');
  rg.addColorStop(0.55, 'rgba(30,110,120,0.08)');
  rg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, S, S);
  // フェルトのノイズ
  const img = ctx.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 26;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  t.needsUpdate = true;
  return t;
}

function feltBumpTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 110 + Math.random() * 60;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 24);
  return t;
}

// ================================================================ createTable

export async function createTable(canvas) {
  // --- renderer
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  setRendererCaps(renderer);

  // --- scene / camera
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x04070f);
  scene.fog = new THREE.FogExp2(0x04070f, 0.038);

  const startW = Math.max(1, canvas.clientWidth || canvas.width || 960);
  const startH = Math.max(1, canvas.clientHeight || canvas.height || 600);
  const camera = new THREE.PerspectiveCamera(40, startW / startH, 0.1, 100);
  const camTarget = new THREE.Vector3(0, 0.05, 0.0);
  const camDir = new THREE.Vector3(0, 7.9, 9.5).sub(camTarget).normalize();
  const BASE_DIST = 12.36;   // 既定の視距離
  const FIT_W = 5.4;         // 収めたい横半幅(ワールド単位)
  const FIT_V = 3.6;         // 収めたい縦半幅(視平面上)
  const camBase = new THREE.Vector3();
  camBase.copy(camDir).multiplyScalar(BASE_DIST).add(camTarget);
  camera.position.copy(camBase);
  camera.lookAt(camTarget);

  // --- lights
  const ambient = new THREE.AmbientLight(0x2a4468, 0.34);
  scene.add(ambient);

  const hemi = new THREE.HemisphereLight(0x8fd6ff, 0x08130c, 0.22);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff2dd, 1.15);
  key.position.set(4.5, 10.5, 5.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -7.5;
  key.shadow.camera.right = 7.5;
  key.shadow.camera.top = 7.5;
  key.shadow.camera.bottom = -7.5;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 2.5;
  scene.add(key);
  scene.add(key.target);

  const spot = new THREE.SpotLight(0xffeecc, 60, 26, 0.68, 0.85, 1.35);
  spot.position.set(0, 10.5, 1.0);
  spot.target.position.set(0, 0, 0.2);
  spot.castShadow = false;
  scene.add(spot);
  scene.add(spot.target);

  const rim = new THREE.DirectionalLight(0x4fa8ff, 0.5);
  rim.position.set(-6, 3.2, -7.5);
  scene.add(rim);

  const rimWarm = new THREE.PointLight(0xff5fa8, 7, 16, 1.8);
  rimWarm.position.set(4.6, 1.6, -3.4);
  scene.add(rimWarm);

  const rimCool = new THREE.PointLight(0x35f2d8, 6, 16, 1.8);
  rimCool.position.set(-4.6, 1.5, 3.2);
  scene.add(rimCool);

  // --- テーブル
  const feltMap = feltTexture();
  const feltBump = feltBumpTexture();
  const tableGeo = new THREE.PlaneGeometry(26, 26, 1, 1);
  const tableMat = new THREE.MeshStandardMaterial({
    map: feltMap,
    bumpMap: feltBump,
    bumpScale: 0.035,
    roughness: 0.97,
    metalness: 0.0,
    color: 0xffffff,
  });
  const table = new THREE.Mesh(tableGeo, tableMat);
  table.rotation.x = -Math.PI / 2;
  table.position.y = TABLE_Y;
  table.receiveShadow = true;
  scene.add(table);

  // テーブル縁（濃い木目風リング）
  const railGeo = new THREE.TorusGeometry(7.4, 0.36, 12, 96);
  const railMat = new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 0.55, metalness: 0.25 });
  const rail = new THREE.Mesh(railGeo, railMat);
  rail.rotation.x = -Math.PI / 2;
  rail.position.y = 0.06;
  rail.receiveShadow = true;
  rail.castShadow = true;
  scene.add(rail);

  // 中央のフロア発光（スポット感を補強）
  const glowGeo = new THREE.CircleGeometry(4.2, 64);
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0x2fe6c0, transparent: true, opacity: 0.05,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = TABLE_Y + 0.004;
  scene.add(glow);

  // ---------------------------------------------------------------- 共有ジオメトリ
  const shape = roundedShape(CARD_W, CARD_H, CARD_R);
  const bodyGeo = new THREE.ExtrudeGeometry(shape, {
    depth: CARD_T, bevelEnabled: false, curveSegments: 8,
  });
  bodyGeo.translate(0, 0, -CARD_T / 2);
  const FACE_Z = CARD_T / 2 + 0.0008;
  bodyGeo.computeVertexNormals();

  const faceGeo = fixShapeUV(new THREE.ShapeGeometry(shape, 8), CARD_W, CARD_H);
  const deckGeo = new THREE.BoxGeometry(CARD_W, 1, CARD_H);

  const disposables = [tableGeo, railGeo, glowGeo, bodyGeo, faceGeo, deckGeo];
  const matDisposables = [tableMat, railMat, glowMat];
  const texDisposables = [feltMap, feltBump];

  // ---------------------------------------------------------------- CardObject

  const sideMatProto = new THREE.MeshStandardMaterial({ color: 0xf3f4f6, roughness: 0.52, metalness: 0.04 });
  matDisposables.push(sideMatProto);

  let cardSerial = 0;
  function createCard() {
    const root = new THREE.Group();
    root.name = 'card' + (cardSerial++);
    const inner = new THREE.Group();
    inner.rotation.x = -Math.PI / 2;  // 寝かせる（表が上）
    root.add(inner);

    const sideMat = sideMatProto.clone();
    const body = new THREE.Mesh(bodyGeo, sideMat);
    body.castShadow = true;
    body.receiveShadow = true;
    inner.add(body);

    const faceMat = new THREE.MeshStandardMaterial({
      map: null, roughness: 0.42, metalness: 0.02,
      emissive: new THREE.Color(0x000000), emissiveIntensity: 1.0,
    });
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.position.z = FACE_Z;
    face.receiveShadow = true;
    inner.add(face);

    const backMat = new THREE.MeshStandardMaterial({
      map: null, roughness: 0.46, metalness: 0.06,
      emissive: new THREE.Color(0x000000), emissiveIntensity: 1.0,
    });
    const back = new THREE.Mesh(faceGeo, backMat);
    back.position.z = -FACE_Z;
    back.rotation.y = Math.PI;
    back.receiveShadow = true;
    inner.add(back);

    const card = {
      root, inner, body, face, back, faceMat, backMat, sideMat,
      key: null, backColor: null, faceUp: true, inUse: false,
      glow: 0, glowTarget: 0, glowColor: new THREE.Color(0x35f2d8),
    };
    root.userData.card = card;
    root.visible = false;
    scene.add(root);
    return card;
  }

  const cardPool = [];
  function obtainCard() {
    for (const c of cardPool) if (!c.inUse) { c.inUse = true; c.root.visible = true; return c; }
    const c = createCard();
    cardPool.push(c);
    c.inUse = true;
    c.root.visible = true;
    return c;
  }
  function releaseCard(c) {
    if (!c) return;
    c.inUse = false;
    c.root.visible = false;
    c.glow = c.glowTarget = 0;
    c.faceMat.emissive.setHex(0x000000);
    c.backMat.emissive.setHex(0x000000);
    c.root.scale.set(1, 1, 1);
  }
  function setCardFace(c, rank, suit) {
    const k = rank + ':' + suit;
    if (c.key === k) return;
    c.key = k;
    c.faceMat.map = getCardTexture(rank, suit);
    c.faceMat.needsUpdate = true;
  }
  function setCardBack(c, color) {
    if (c.backColor === color) return;
    c.backColor = color;
    c.backMat.map = getBackTexture(color);
    c.backMat.needsUpdate = true;
  }
  function setFaceUp(c, up) {
    c.faceUp = !!up;
    c.inner.rotation.x = up ? -Math.PI / 2 : Math.PI / 2;
  }

  // ---------------------------------------------------------------- 山札(デッキ)

  function createDeck(color) {
    const sides = new THREE.MeshStandardMaterial({ color: 0xe9ebf0, roughness: 0.75, metalness: 0.02 });
    const top = new THREE.MeshStandardMaterial({ map: getBackTexture(color), roughness: 0.5, metalness: 0.06 });
    const bottom = new THREE.MeshStandardMaterial({ color: 0xdfe2e8, roughness: 0.8 });
    const mats = [sides, sides, top, bottom, sides, sides];
    const m = new THREE.Mesh(deckGeo, mats);
    m.castShadow = true;
    m.receiveShadow = true;
    m.visible = false;
    scene.add(m);
    matDisposables.push(sides, top, bottom);
    return { mesh: m, count: -1 };
  }
  // rules.js の配分に合わせる: 人間=赤札(hearts/diamonds)、Jev=黒札(spades/clubs)
  const humanDeck = createDeck('red');
  const cpuDeck = createDeck('black');
  humanDeck.mesh.position.set(STOCK_HUMAN.x, 0, STOCK_HUMAN.z);
  humanDeck.mesh.rotation.y = -0.16;
  cpuDeck.mesh.position.set(STOCK_CPU.x, 0, STOCK_CPU.z);
  cpuDeck.mesh.rotation.y = 0.16;

  function syncDeck(deck, count) {
    if (deck.count === count) return;
    deck.count = count;
    const n = Math.max(0, count);
    deck.mesh.visible = n > 0;
    const th = Math.max(0.02, n * 0.016);
    deck.mesh.scale.y = th;
    deck.mesh.position.y = TABLE_Y + th / 2 + 0.002;
  }

  // 台札の下に溜まる厚み
  function createPileBase() {
    const sides = new THREE.MeshStandardMaterial({ color: 0xe6e9ef, roughness: 0.8 });
    const top = new THREE.MeshStandardMaterial({ color: 0xcfd4de, roughness: 0.8 });
    const mats = [sides, sides, top, sides, sides, sides];
    const m = new THREE.Mesh(deckGeo, mats);
    m.castShadow = true;
    m.receiveShadow = true;
    m.visible = false;
    scene.add(m);
    matDisposables.push(sides, top);
    return m;
  }
  const pileBases = [createPileBase(), createPileBase()];
  const pileDepth = [0, 0];
  pileBases[0].position.set(-PILE_X, 0, PILE_Z);
  pileBases[1].position.set(PILE_X, 0, PILE_Z);

  function syncPileBase(i) {
    const n = Math.min(pileDepth[i], 26);
    const th = Math.max(0.001, n * 0.012);
    pileBases[i].visible = n > 0;
    pileBases[i].scale.y = th;
    pileBases[i].position.y = TABLE_Y + th / 2;
    return TABLE_Y + th;
  }

  // ---------------------------------------------------------------- 台札マーカー(ピック用 + ハイライト)

  const pileRingGeo = new THREE.RingGeometry(0.72, 0.92, 48);
  const pileHitGeo = new THREE.PlaneGeometry(CARD_W * 1.5, CARD_H * 1.35);
  disposables.push(pileRingGeo, pileHitGeo);

  const pileMarkers = [];
  for (let i = 0; i < 2; i++) {
    const g = new THREE.Group();
    g.position.set(i === 0 ? -PILE_X : PILE_X, TABLE_Y + 0.006, PILE_Z);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x6cf7d2, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(pileRingGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.scale.setScalar(1.35);
    g.add(ring);

    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    const hit = new THREE.Mesh(pileHitGeo, hitMat);
    hit.rotation.x = -Math.PI / 2;
    hit.position.y = 0.02;
    hit.userData.pileIndex = i;
    g.add(hit);

    scene.add(g);
    matDisposables.push(ringMat, hitMat);
    pileMarkers.push({ group: g, ring, ringMat, hit, on: false, amt: 0 });
  }

  // ---------------------------------------------------------------- 状態

  const handSize = 5;
  /** @type {Array<{card:any,key:string|null}>} */
  const humanSlots = Array.from({ length: handSize }, () => ({ card: null, key: null }));
  const cpuSlots = Array.from({ length: handSize }, () => ({ card: null, key: null }));
  const pileCards = [null, null];
  const pileKeys = [null, null];
  const pilePending = [undefined, undefined];
  const pileLocked = [false, false];

  let hoverSlot = null;
  let selectedSlot = null;
  let revealCpu = false;
  let phase = 'ready';
  let combo = 0;
  let elapsed = 0;

  const shake = { mag: 0, decay: 7.0, t: 0 };
  const tweens = [];
  const flyers = [];

  // レイアウト計算
  function handLayout(i, n) {
    const c = (n - 1) / 2;
    const d = i - c;
    return {
      x: d * 1.16,
      z: HAND_Z + Math.abs(d) * 0.16,
      yaw: -d * 0.155,
      y: REST_Y + i * 0.004,
    };
  }
  function cpuLayout(i, n) {
    const c = (n - 1) / 2;
    const d = i - c;
    return {
      x: -d * 1.10,
      z: CPU_Z - Math.abs(d) * 0.14,
      yaw: -d * 0.10 + Math.PI,
      y: REST_Y + i * 0.004,
    };
  }

  function applyHandRest(card, i, n, lift, tilt) {
    const L = handLayout(i, n);
    card.root.position.set(L.x, L.y + lift, L.z - lift * 0.22);
    card.root.rotation.set(tilt, L.yaw, 0);
  }

  // ---------------------------------------------------------------- tween

  function tween(opts) {
    const t = {
      t: 0, dur: Math.max(1, opts.dur || 300), delay: opts.delay || 0,
      onUpdate: opts.onUpdate, onComplete: opts.onComplete,
      ease: opts.ease || ease.outCubic, done: false,
    };
    tweens.push(t);
    return t;
  }
  function updateTweens(dt) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const t = tweens[i];
      if (t.delay > 0) { t.delay -= dt; continue; }
      t.t += dt;
      const k = Math.min(1, t.t / t.dur);
      try { if (t.onUpdate) t.onUpdate(t.ease(k), k); } catch (_) {}
      if (k >= 1) {
        tweens.splice(i, 1);
        try { if (t.onComplete) t.onComplete(); } catch (_) {}
      }
    }
  }

  // ---------------------------------------------------------------- syncState

  function pileTopY(i) { return syncPileBase(i) + CARD_T / 2 + 0.002; }

  function placePileCard(i, card) {
    card.root.position.set(i === 0 ? -PILE_X : PILE_X, pileTopY(i), PILE_Z);
    card.root.rotation.set(0, 0, 0);
    setFaceUp(card, true);
  }

  function setPile(i, cd) {
    const k = cd ? cd.rank + ':' + cd.suit : null;
    if (pileKeys[i] === k) {
      if (pileCards[i]) placePileCard(i, pileCards[i]);
      return;
    }
    pileKeys[i] = k;
    if (!cd) {
      if (pileCards[i]) { releaseCard(pileCards[i]); pileCards[i] = null; }
      pileDepth[i] = 0;
      syncPileBase(i);
      return;
    }
    pileDepth[i] = Math.min(26, pileDepth[i] + 1);
    let c = pileCards[i];
    if (!c) { c = obtainCard(); pileCards[i] = c; }
    setCardFace(c, cd.rank, cd.suit);
    setCardBack(c, 'black');
    placePileCard(i, c);
  }

  function syncHand(slots, view, who, faceDown) {
    const n = slots.length;
    const backColor = who === 'human' ? 'red' : 'black';
    for (let i = 0; i < n; i++) {
      const cd = view && view[i] ? view[i] : null;
      const s = slots[i];
      const k = cd ? cd.rank + ':' + cd.suit : null;
      if (!cd) {
        if (s.card) { releaseCard(s.card); s.card = null; }
        s.key = null;
        continue;
      }
      let fresh = false;
      if (!s.card) { s.card = obtainCard(); fresh = true; }
      const c = s.card;
      setCardFace(c, cd.rank, cd.suit);
      setCardBack(c, backColor);
      if (s.key !== k) {
        s.key = k;
        if (!fresh) fresh = true;
      }
      setFaceUp(c, !faceDown);
      if (who === 'human') {
        if (c !== draggedCard) applyHandRest(c, i, n, 0, 0);
      } else {
        const L = cpuLayout(i, n);
        c.root.position.set(L.x, L.y, L.z);
        c.root.rotation.set(0, L.yaw, 0);
      }
      if (fresh) {
        // 補充カードは軽くポップイン
        const target = c.root.position.clone();
        c.root.scale.setScalar(0.65);
        tween({
          dur: 260, ease: ease.outBack,
          onUpdate: (e) => {
            c.root.scale.setScalar(0.65 + 0.35 * e);
            c.root.position.y = target.y + (1 - e) * 0.5;
          },
          onComplete: () => { c.root.scale.setScalar(1); c.root.position.y = target.y; },
        });
      }
    }
  }

  let draggedCard = null; // animatePlay 中に手札から取り除いたカード

  function syncState(view) {
    if (!view) return;
    phase = view.phase || phase;
    combo = view.combo || 0;
    if (typeof view.revealCpuHand === 'boolean') revealCpu = view.revealCpuHand;

    if (view.piles) {
      for (let i = 0; i < 2; i++) {
        if (pileLocked[i]) { pilePending[i] = view.piles[i] || null; continue; }
        setPile(i, view.piles[i] || null);
      }
    }
    if (view.human) {
      syncHand(humanSlots, view.human.hand, 'human', false);
      syncDeck(humanDeck, view.human.stockCount | 0);
    }
    if (view.cpu) {
      const fd = view.cpu.faceDown !== false && !revealCpu;
      syncHand(cpuSlots, view.cpu.hand, 'cpu', fd);
      syncDeck(cpuDeck, view.cpu.stockCount | 0);
    }
    if (selectedSlot != null && !humanSlots[selectedSlot]?.card) selectedSlot = null;
  }

  // ---------------------------------------------------------------- ピッキング

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function toNDC(clientX, clientY) {
    // CSS ピクセル基準。devicePixelRatio は getBoundingClientRect が吸収するので不要。
    const r = canvas.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    return ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1;
  }

  function pickHandSlot(clientX, clientY) {
    if (!toNDC(clientX, clientY)) return null;
    raycaster.setFromCamera(ndc, camera);
    const targets = [];
    for (const s of humanSlots) if (s.card) targets.push(s.card.root);
    if (!targets.length) return null;
    const hits = raycaster.intersectObjects(targets, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && !o.userData.card) o = o.parent;
    if (!o) return null;
    const c = o.userData.card;
    for (let i = 0; i < humanSlots.length; i++) if (humanSlots[i].card === c) return i;
    return null;
  }

  function pickPile(clientX, clientY) {
    if (!toNDC(clientX, clientY)) return null;
    raycaster.setFromCamera(ndc, camera);
    const targets = [pileMarkers[0].hit, pileMarkers[1].hit];
    for (let i = 0; i < 2; i++) if (pileCards[i]) targets.push(pileCards[i].root);
    const hits = raycaster.intersectObjects(targets, true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o) {
      if (o.userData && o.userData.pileIndex != null) return o.userData.pileIndex;
      if (o.userData && o.userData.card) {
        for (let i = 0; i < 2; i++) if (pileCards[i] === o.userData.card) return i;
      }
      o = o.parent;
    }
    return null;
  }

  // ホバーは自前で追跡（契約に setHover が無いため）
  function onPointerMove(ev) {
    const s = pickHandSlot(ev.clientX, ev.clientY);
    hoverSlot = s;
    canvas.style.cursor = s != null ? 'pointer' : '';
  }
  function onPointerLeave() { hoverSlot = null; canvas.style.cursor = ''; }
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);

  // ---------------------------------------------------------------- アニメーション

  function animatePlay(opts) {
    const o = opts || {};
    const by = o.by === 'cpu' ? 'cpu' : 'human';
    const toPile = (o.toPile | 0) === 1 ? 1 : 0;
    const slot = o.fromSlot != null ? (o.fromSlot | 0) : 0;
    const cd = o.card || null;

    const slots = by === 'human' ? humanSlots : cpuSlots;
    const src = slots[slot];

    // 飛ばすカードを確保（手札のカードをそのまま使い、手札側は即座に空ける）
    let flyer;
    if (src && src.card) {
      flyer = src.card;
      src.card = null;
      src.key = null;
    } else {
      flyer = obtainCard();
      const L = by === 'human' ? handLayout(slot, handSize) : cpuLayout(slot, handSize);
      flyer.root.position.set(L.x, L.y, L.z);
      flyer.root.rotation.set(0, L.yaw, 0);
    }
    if (cd) setCardFace(flyer, cd.rank, cd.suit);
    setCardBack(flyer, by === 'human' ? 'red' : 'black');
    flyer.root.scale.set(1, 1, 1);
    flyers.push(flyer);

    if (selectedSlot === slot && by === 'human') selectedSlot = null;

    // 台札の更新をロック（着地まで旧カードを見せる）
    pileLocked[toPile] = true;

    const p0 = flyer.root.position.clone();
    const r0 = { x: flyer.root.rotation.x, y: flyer.root.rotation.y, z: flyer.root.rotation.z };
    const startFaceUp = flyer.faceUp;
    const endX = toPile === 0 ? -PILE_X : PILE_X;
    const endZ = PILE_Z;
    const dist = Math.hypot(endX - p0.x, endZ - p0.z);
    const arc = 1.25 + dist * 0.2;
    const spin = (by === 'cpu' ? -1 : 1) * (Math.PI * 2);
    const dur = 340;

    tween({
      dur,
      ease: ease.inOutQuart,
      onUpdate: (e) => {
        flyer.root.position.x = p0.x + (endX - p0.x) * e;
        flyer.root.position.z = p0.z + (endZ - p0.z) * e;
        const h = Math.sin(Math.PI * e);
        flyer.root.position.y = p0.y + (0.12 - p0.y) * e + h * arc;
        // 回転は着地で 0 に揃う
        flyer.root.rotation.y = r0.y * (1 - e) + spin * Math.sin(Math.PI * e) * 0.35;
        flyer.root.rotation.x = r0.x * (1 - e) - h * 0.5;
        flyer.root.rotation.z = Math.sin(e * Math.PI * 2) * 0.22 * (1 - e);
        // 裏 -> 表のフリップ
        if (!startFaceUp) {
          const k = Math.min(1, Math.max(0, (e - 0.15) / 0.55));
          flyer.inner.rotation.x = Math.PI / 2 - Math.PI * ease.inOutCubic(k);
        }
        const s = 1 + h * 0.18;
        flyer.root.scale.set(s, s, s);
      },
      onComplete: () => {
        // 着地: 旧台札カードを解放し flyer を新しい台札トップに
        setFaceUp(flyer, true);
        flyer.root.rotation.set(0, 0, 0);
        flyer.root.scale.set(1, 1, 1);
        const idx = flyers.indexOf(flyer);
        if (idx >= 0) flyers.splice(idx, 1);

        const old = pileCards[toPile];
        if (old && old !== flyer) releaseCard(old);
        pileCards[toPile] = flyer;
        pileKeys[toPile] = cd ? cd.rank + ':' + cd.suit : flyer.key;
        pileDepth[toPile] = Math.min(26, pileDepth[toPile] + 1);
        const restY = pileTopY(toPile);
        flyer.root.position.set(endX, restY, endZ);

        // バウンド
        tween({
          dur: 420, ease: ease.outBounce,
          onUpdate: (e) => {
            flyer.root.position.y = restY + (1 - e) * 0.34;
            const s = 1 + (1 - e) * 0.06;
            flyer.root.scale.set(s, 1, s);
          },
          onComplete: () => {
            flyer.root.position.y = restY;
            flyer.root.scale.set(1, 1, 1);
            pileLocked[toPile] = false;
            if (pilePending[toPile] !== undefined) {
              const p = pilePending[toPile];
              pilePending[toPile] = undefined;
              setPile(toPile, p);
            }
          },
        });
        // 着地の衝撃
        cameraShake(0.16);
      },
    });
  }

  function animateFlip(cards) {
    const list = Array.isArray(cards) ? cards : [];
    for (let i = 0; i < 2; i++) {
      const cd = list[i] || null;
      pileLocked[i] = true;
      const delay = i * 90;
      tween({
        dur: 1, delay,
        onComplete: () => {
          if (cd) { pileDepth[i] = Math.min(26, pileDepth[i] + 1); setPileImmediate(i, cd); }
          const c = pileCards[i];
          if (!c) { pileLocked[i] = false; return; }
          const restY = pileTopY(i);
          c.inner.rotation.x = Math.PI / 2;
          tween({
            dur: 480, ease: ease.outCubic,
            onUpdate: (e) => {
              c.inner.rotation.x = Math.PI / 2 - Math.PI * e;
              c.root.position.y = restY + Math.sin(Math.PI * e) * 0.9;
              c.root.rotation.y = (1 - e) * 1.4;
            },
            onComplete: () => {
              setFaceUp(c, true);
              c.root.position.y = restY;
              c.root.rotation.y = 0;
              pileLocked[i] = false;
              if (pilePending[i] !== undefined) { const p = pilePending[i]; pilePending[i] = undefined; setPile(i, p); }
            },
          });
        },
      });
    }
    cameraShake(0.35);
  }

  function setPileImmediate(i, cd) {
    const k = cd ? cd.rank + ':' + cd.suit : null;
    pileKeys[i] = k;
    if (!cd) { if (pileCards[i]) { releaseCard(pileCards[i]); pileCards[i] = null; } return; }
    let c = pileCards[i];
    if (!c) { c = obtainCard(); pileCards[i] = c; }
    setCardFace(c, cd.rank, cd.suit);
    setCardBack(c, 'black');
    c.root.position.set(i === 0 ? -PILE_X : PILE_X, pileTopY(i), PILE_Z);
    c.root.rotation.set(0, 0, 0);
  }

  function setSelected(slot) {
    selectedSlot = (slot == null) ? null : (slot | 0);
  }

  function highlightPiles(list) {
    const set = new Set(Array.isArray(list) ? list.map((v) => v | 0) : []);
    for (let i = 0; i < 2; i++) pileMarkers[i].on = set.has(i);
  }

  function cameraShake(magnitude) {
    const m = Math.max(0, Number(magnitude) || 0);
    shake.mag = Math.max(shake.mag, m);
    shake.t = 0;
  }

  // ---------------------------------------------------------------- render

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  /** VFX 用内部フック: OutputPass の直前にパスを挿入 */
  function _registerPass(pass) {
    if (!pass) return;
    const idx = Math.max(0, composer.passes.length - 1);
    composer.insertPass(pass, idx);
  }

  const camPos = new THREE.Vector3();
  let disposed = false;

  // --- 適応的ピクセル比（60fps 維持用のセーフティ）
  const MAX_PR = Math.min(window.devicePixelRatio || 1, 2);
  let curPR = MAX_PR;
  let cssW = startW, cssH = startH;
  let perfAvg = 16.7, perfLast = 0, perfCooldown = 180;
  function applyPixelRatio() {
    renderer.setPixelRatio(curPR);
    renderer.setSize(cssW, cssH, false);
    composer.setPixelRatio(curPR);
    composer.setSize(cssW, cssH);
  }
  function perfGuard() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (perfLast) {
      const real = now - perfLast;
      if (real > 0 && real < 250) perfAvg += (real - perfAvg) * 0.06;
    }
    perfLast = now;
    if (perfCooldown > 0) { perfCooldown--; return; }
    if (perfAvg > 26 && curPR > 1) {
      curPR = Math.max(1, curPR - 0.25); applyPixelRatio(); perfCooldown = 150;
    } else if (perfAvg < 13 && curPR < MAX_PR) {
      curPR = Math.min(MAX_PR, curPR + 0.25); applyPixelRatio(); perfCooldown = 300;
    }
  }

  function render(dtMs) {
    if (disposed) return;
    const dt = Math.min(64, Math.max(0, Number(dtMs) || 0));
    elapsed += dt;
    updateTweens(dt);

    const s = dt / 1000;

    // 手札のホバー / 選択
    const n = humanSlots.length;
    for (let i = 0; i < n; i++) {
      const c = humanSlots[i].card;
      if (!c || flyers.indexOf(c) >= 0) continue;
      const isSel = selectedSlot === i;
      const isHov = hoverSlot === i;
      const targetLift = isSel ? SEL_LIFT : (isHov ? HOVER_LIFT : 0);
      const targetTilt = isSel ? -0.42 : (isHov ? -0.26 : 0);
      c.root.userData.lift = damp(c.root.userData.lift || 0, targetLift, 14, s);
      c.root.userData.tilt = damp(c.root.userData.tilt || 0, targetTilt, 14, s);
      applyHandRest(c, i, n, c.root.userData.lift, c.root.userData.tilt);
      if (isSel) {
        c.root.position.y += Math.sin(elapsed * 0.006) * 0.03;
        c.root.rotation.y += Math.sin(elapsed * 0.004) * 0.05;
      }
      c.glowTarget = isSel ? 1 : (isHov ? 0.32 : 0);
      c.glow = damp(c.glow, c.glowTarget, 12, s);
      const g = c.glow;
      if (g > 0.002 || c.faceMat.emissive.r > 0.002) {
        const base = isSel ? 0x2ff0c8 : 0x2a8cff;
        c.glowColor.setHex(base);
        c.faceMat.emissive.copy(c.glowColor).multiplyScalar(g * (isSel ? 0.26 : 0.12));
        c.sideMat.emissive = c.sideMat.emissive || new THREE.Color();
        c.sideMat.emissive.copy(c.glowColor).multiplyScalar(g * 0.85);
      }
    }

    // 台札ハイライトのパルス
    for (let i = 0; i < 2; i++) {
      const pm = pileMarkers[i];
      pm.amt = damp(pm.amt, pm.on ? 1 : 0, 10, s);
      const pulse = 0.55 + 0.45 * Math.sin(elapsed * 0.008 + i * 1.3);
      pm.ringMat.opacity = pm.amt * (0.35 + 0.5 * pulse);
      pm.ring.scale.setScalar(1.32 + pm.amt * 0.1 * pulse);
      const pc = pileCards[i];
      if (pc) {
        pc.faceMat.emissive.setRGB(0.0, 0.14 * pm.amt * pulse, 0.11 * pm.amt * pulse);
      }
    }

    // 中央グロー & リムライトの揺らぎ
    glowMat.opacity = 0.04 + 0.02 * Math.sin(elapsed * 0.0015) + Math.min(0.09, combo * 0.015);
    rimWarm.intensity = 6.5 + Math.sin(elapsed * 0.0021) * 2.0;
    rimCool.intensity = 5.5 + Math.cos(elapsed * 0.0017) * 2.0;

    // カメラシェイク
    camPos.copy(camBase);
    if (shake.mag > 0.0005) {
      shake.t += s;
      const m = shake.mag;
      camPos.x += (Math.random() - 0.5) * m * 2;
      camPos.y += (Math.random() - 0.5) * m * 1.4;
      camPos.z += (Math.random() - 0.5) * m * 1.2;
      shake.mag *= Math.exp(-shake.decay * s);
      if (shake.mag < 0.0005) shake.mag = 0;
    }
    camera.position.copy(camPos);
    camera.lookAt(camTarget);

    perfGuard();
    composer.render();
  }

  function resize(w, h) {
    const W = Math.max(1, Math.floor(w || canvas.clientWidth || 1));
    const H = Math.max(1, Math.floor(h || canvas.clientHeight || 1));
    cssW = W; cssH = H;
    renderer.setPixelRatio(curPR);
    renderer.setSize(W, H, false);
    composer.setPixelRatio(curPR);
    composer.setSize(W, H);
    const aspect = W / H;
    camera.aspect = aspect;
    // 縦長画面でも盤面が収まるよう FOV -> 視距離の順で調整する
    const DEG = Math.PI / 180;
    let t = Math.max(FIT_W / (aspect * BASE_DIST), FIT_V / BASE_DIST);
    let fov = Math.min(68, Math.max(40, 2 * Math.atan(t) / DEG));
    t = Math.tan(fov / 2 * DEG);
    const dist = Math.max(BASE_DIST, FIT_W / (t * aspect), FIT_V / t);
    camera.fov = fov;
    camBase.copy(camDir).multiplyScalar(dist).add(camTarget);
    camera.position.copy(camBase);
    camera.lookAt(camTarget);
    camera.updateProjectionMatrix();
  }
  resize(startW, startH);

  function dispose() {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    tweens.length = 0;
    try { if (api._onDispose) api._onDispose(); } catch (_) {}
    scene.traverse((o) => {
      if (o.isMesh) {
        if (o.geometry) o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x && x.dispose && x.dispose());
        else if (m && m.dispose) m.dispose();
      }
      if (o.isPoints) {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      }
    });
    for (const g of disposables) { try { g.dispose(); } catch (_) {} }
    for (const m of matDisposables) { try { m.dispose(); } catch (_) {} }
    for (const t of texDisposables) { try { t.dispose(); } catch (_) {} }
    try { composer.dispose(); } catch (_) {}
    try { disposeAll(); } catch (_) {}
    try { renderer.dispose(); } catch (_) {}
    scene.clear();
  }

  // ---------------------------------------------------------------- 位置ヘルパー(VFX 用)

  function pilePosition(i) {
    const idx = (i | 0) === 1 ? 1 : 0;
    return { x: idx === 0 ? -PILE_X : PILE_X, y: pileTopY(idx) + 0.05, z: PILE_Z };
  }
  function handPosition(who, slot) {
    const L = who === 'cpu' ? cpuLayout(slot | 0, handSize) : handLayout(slot | 0, handSize);
    return { x: L.x, y: L.y + 0.1, z: L.z };
  }
  function centerPosition() { return { x: 0, y: 0.6, z: PILE_Z }; }

  const api = {
    syncState, render, resize, pickHandSlot, pickPile,
    animatePlay, animateFlip, setSelected, highlightPiles, cameraShake, dispose,
    // --- 追加ヘルパー（契約外・互換のため追加のみ）
    pilePosition, handPosition, centerPosition,
    // --- VFX 連携用の内部フック
    _registerPass,
    _scene: scene,
    _camera: camera,
    _renderer: renderer,
    _composer: composer,
    _pilePosition: pilePosition,
    _handPosition: handPosition,
    _onDispose: null,
  };

  // テクスチャの先読み（描画は待たせない）
  preloadAll().catch(() => {});

  return api;
}
