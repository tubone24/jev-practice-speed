// mood.js の単体テスト。実行: node --test test/mood.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { MOODS, MOOD_IDLE, classifyPressure, pickLine } from '../public/js/mood.js';
import { PRESSURE_LEVELS } from '../public/js/ai.js';

test('段階は 5 つで、from が単調増加し 0 から始まる', () => {
  assert.equal(MOODS.length, 5);
  assert.equal(MOODS[0].from, 0);
  for (let i = 1; i < MOODS.length; i++) {
    assert.ok(MOODS[i].from > MOODS[i - 1].from, `${MOODS[i].id} の from は前より大きい`);
  }
  for (const m of MOODS) assert.ok(m.lines.length >= 1, `${m.id} にセリフがある`);
});

test('score が無い / 数値でないときは待機', () => {
  assert.equal(classifyPressure(null), MOOD_IDLE);
  assert.equal(classifyPressure(undefined), MOOD_IDLE);
  assert.equal(classifyPressure(NaN), MOOD_IDLE);
  assert.equal(classifyPressure('2'), MOOD_IDLE);
  assert.equal(MOOD_IDLE.id, 'idle');
});

test('0..3 の score を両端と中間で正しく分類する', () => {
  // Jev の pressure は criteria 4 段階 → 0..3
  assert.equal(PRESSURE_LEVELS.length - 1, 3);
  const max = PRESSURE_LEVELS.length - 1;
  assert.equal(classifyPressure(0, { max }).id, 'relaxed');
  assert.equal(classifyPressure(0.3, { max }).id, 'relaxed');
  assert.equal(classifyPressure(1.0, { max }).id, 'steady');
  assert.equal(classifyPressure(1.5, { max }).id, 'strained');
  assert.equal(classifyPressure(2.0, { max }).id, 'cornered');
  assert.equal(classifyPressure(2.6, { max }).id, 'checkmate');
  assert.equal(classifyPressure(3, { max }).id, 'checkmate');
});

test('level は 0..1 に正規化され、範囲外の score はクランプされる', () => {
  assert.equal(classifyPressure(-1).level, 0);
  assert.equal(classifyPressure(99).level, 1);
  assert.equal(classifyPressure(1.5).level, 0.5);
  assert.equal(classifyPressure(2, { max: 4 }).level, 0.5);
  // max が不正なら既定の 3 を使う
  assert.equal(classifyPressure(3, { max: 0 }).max, 3);
  assert.equal(classifyPressure(3, { max: -2 }).level, 1);
});

test('index と label が段階定義と一致し、score/confidence を持ち回る', () => {
  const m = classifyPressure(2.9, { confidence: 0.83 });
  assert.equal(m.index, MOODS.length - 1);
  assert.equal(m.label, MOODS.at(-1).label);
  assert.equal(m.score, 2.9);
  assert.equal(m.confidence, 0.83);
  // confidence は 0..1 に収める
  assert.equal(classifyPressure(1, { confidence: 7 }).confidence, 1);
  assert.equal(classifyPressure(1, { confidence: NaN }).confidence, 0);
});

test('score が高いほど段階が単調に上がる', () => {
  let prev = -1;
  for (let s = 0; s <= 3.0001; s += 0.05) {
    const { index } = classifyPressure(s);
    assert.ok(index >= prev, `score=${s.toFixed(2)} で段階が戻らない`);
    prev = index;
  }
  assert.equal(prev, MOODS.length - 1, '3 で最上段に到達する');
});

test('pickLine は段階のセリフから選び、avoid を避ける', () => {
  const mood = classifyPressure(0);
  const def = MOODS[mood.index];
  for (let i = 0; i < 30; i++) {
    const line = pickLine(mood, { avoid: def.lines[0] });
    assert.ok(def.lines.includes(line));
    assert.notEqual(line, def.lines[0]);
  }
  // rng を固定すれば決定的
  assert.equal(pickLine(mood, { rng: () => 0 }), def.lines[0]);
  assert.equal(pickLine(mood, { rng: () => 0.999 }), def.lines.at(-1));
  // 待機状態には決まったセリフが無い
  assert.equal(pickLine(MOOD_IDLE), '…');
});
