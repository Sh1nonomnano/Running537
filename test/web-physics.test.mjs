import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const sandbox = { console, Math, Object, Set };
sandbox.globalThis = sandbox;
runInContext(readFileSync(new URL("../web/js/game.js", import.meta.url), "utf8"), createContext(sandbox));
const { UsagiRun } = sandbox;
const { CONFIG, createSession } = UsagiRun;

function fresh(rng = () => 0.9) {
  return createSession({ rng });
}

test("开局砖块可见，并且出现在角色前方", () => {
  const s = fresh();
  assert.equal(s.blocks.length, CONFIG.blockCount);
  for (const block of s.blocks) {
    assert.equal(block.visible, true);
    assert.ok(block.x > s.player.x + s.player.w);
  }
});

test("下蹲碰撞箱比站立更小，能避开高砖，仍会撞上矮砖", () => {
  const s = fresh();
  s.setDuckHeld(true);
  s.update(1 / 60);
  const stand = s.player.standingRect;
  const duck = s.player.duckRect;
  assert.ok(duck.w * duck.h < stand.w * stand.h);
  assert.ok(duck.y > stand.y);
  assert.ok(duck.y >= CONFIG.upperY + CONFIG.blockH);
  assert.equal(s.player.ducked, true);

  smack(s, CONFIG.upperY, true);
  assert.equal(s.player.x, CONFIG.playerX);
  assert.equal(s.player.alive, true);

  smack(s, CONFIG.lowerY, true);
  assert.ok(s.player.x < CONFIG.playerX);
});

test("站立会被高砖和矮砖撞到", () => {
  const high = fresh();
  smack(high, CONFIG.upperY, false);
  assert.ok(high.player.x < CONFIG.playerX);

  const low = fresh();
  smack(low, CONFIG.lowerY, false);
  assert.ok(low.player.x < CONFIG.playerX);
});

test("按住下蹲会一直蹲着，松开立刻站起", () => {
  const s = fresh();
  s.setDuckHeld(true);
  s.update(0.1);
  s.update(1);
  assert.equal(s.player.ducked, true);
  s.setDuckHeld(false);
  s.update(1 / 60);
  assert.equal(s.player.ducked, false);
});

test("跳跃中不使用下蹲碰撞箱", () => {
  const s = fresh();
  s.setDuckHeld(true);
  s.update(1 / 60);
  assert.equal(s.jump(), true);
  assert.equal(s.player.ducked, false);
  assert.equal(s.player.grounded(), false);
  s.update(1 / 60);
  assert.equal(s.player.ducked, false);
});

test("画面分数和结算用的是同一个秒数，不再除以 100", () => {
  const s = fresh();
  for (let i = 0; i < 300; i++) s.update(1 / 60);
  assert.equal(s.score, 5);
  assert.notEqual(s.score, Math.floor((s.ticks) / 100));
});

test("砖块速度按原作节奏加快，到 -290 停止", () => {
  const s = fresh();
  assert.equal(s.blockSpeed, -200);
  for (let i = 0; i < 500; i++) park(s);
  assert.equal(s.blockSpeed, -210);
  for (let i = 0; i < 4000; i++) park(s);
  assert.equal(s.blockSpeed, -290);
  for (let i = 0; i < 600; i++) park(s);
  assert.equal(s.blockSpeed, -290);
});

function park(s) {
  for (const block of s.blocks) block.y = -1000;
  s.update(1 / 60);
}

test("砖块绕回后仍然可见", () => {
  const s = fresh(() => 0.9);
  const block = s.blocks[0];
  block.y = CONFIG.upperY;
  block.x = -80;
  s.update(1 / 60);
  assert.equal(block.visible, true);
  assert.equal(block.y, CONFIG.lowerY);
  assert.ok(block.x > CONFIG.width);
});

test("不躲的话会被砖块撞出屏幕", () => {
  const s = fresh(() => 0.9);
  for (let i = 0; i < 60 * 8; i++) s.update(1 / 60);
  assert.equal(s.player.alive, false);
});

test("一直蹲能躲过一连串高砖", () => {
  const s = fresh(() => 0);
  for (let i = 0; i < 60 * 12; i++) {
    s.setDuckHeld(true);
    s.update(1 / 60);
  }
  assert.equal(s.player.alive, true);
  assert.equal(s.player.x, CONFIG.playerX);
});

test("起跳能躲过一连串矮砖", () => {
  const s = fresh(() => 0.9);
  const result = run(s, 12, () => 0.9);
  assert.equal(result.x, CONFIG.playerX, JSON.stringify(result));
  assert.equal(result.alive, true);
});

test("混合高低砖时，跳和蹲都能活过半分钟", () => {
  for (const seed of [1, 2, 7, 42]) {
    const rng = mulberry32(seed);
    const s = fresh(rng);
    const result = run(s, 30, rng);
    assert.equal(result.alive, true, `seed ${seed} ${JSON.stringify(result)}`);
    assert.equal(result.x, CONFIG.playerX, `seed ${seed} ${JSON.stringify(result)}`);
    assert.equal(result.score, 30);
  }
});

test("连续撞上四次就结束", () => {
  const s = fresh();
  smack(s, CONFIG.lowerY, false);
  smack(s, CONFIG.lowerY, false);
  smack(s, CONFIG.lowerY, false);
  assert.equal(s.player.alive, true);
  smack(s, CONFIG.lowerY, false);
  assert.equal(s.player.alive, false);
  assert.ok(s.player.x < -CONFIG.playerW / 2);
});

function smack(s, y, duck) {
  for (const block of s.blocks) block.x = 4000;
  const block = s.blocks[0];
  block.visible = true;
  block.y = y;
  block.x = s.player.x + 10 - s.blockSpeed * (1 / 60);
  s.setDuckHeld(duck);
  s.update(1 / 60);
}

function run(s, seconds, rng) {
  const dt = 1 / 60;
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) {
    steer(s);
    s.update(dt);
    if (!s.player.alive) {
      return { alive: false, x: s.player.x, score: s.score, frame: i, speed: s.blockSpeed };
    }
  }
  return { alive: true, x: s.player.x, score: s.score, speed: s.blockSpeed, rng };
}

function steer(s) {
  let duck = false;
  let jump = false;
  const front = s.player.standingRect.x + s.player.standingRect.w;
  for (const block of s.blocks) {
    if (!block.visible) continue;
    const gap = block.x - front;
    if (block.y === CONFIG.upperY) {
      if (gap < 140 && gap > -80) duck = true;
    } else if (gap < 50 && gap > 24 && s.player.grounded()) {
      jump = true;
    }
  }
  s.setDuckHeld(duck);
  if (jump) s.jump();
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
