import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DICE,
  MAX_SIDES,
  RPS_CHOICES,
  compareThrows,
  describeRoll,
  isChoice,
  looksLikeRoll,
  matchWinner,
  parseRollCommand,
  resolveRound,
  rollDice,
} from '../server/games.js';

// ──────────────────────────────────────────── rock, paper, scissors

test('every pairing of throws resolves the way the playground says', () => {
  const expected = {
    'rock/rock': 0, 'rock/paper': -1, 'rock/scissors': 1,
    'paper/rock': 1, 'paper/paper': 0, 'paper/scissors': -1,
    'scissors/rock': -1, 'scissors/paper': 1, 'scissors/scissors': 0,
  };
  for (const a of RPS_CHOICES) {
    for (const b of RPS_CHOICES) {
      assert.equal(compareThrows(a, b), expected[`${a}/${b}`], `${a} vs ${b}`);
    }
  }
});

test('the comparison is antisymmetric — nobody wins both ways', () => {
  for (const a of RPS_CHOICES) {
    for (const b of RPS_CHOICES) {
      // Summing avoids strict equality's 0 / -0 distinction.
      assert.equal(compareThrows(a, b) + compareThrows(b, a), 0, `${a} vs ${b}`);
    }
  }
});

test('only the three throws are throws', () => {
  assert.equal(isChoice('rock'), true);
  assert.equal(isChoice('lizard'), false, 'no Spock rules here');
  assert.equal(isChoice(''), false);
  assert.equal(isChoice(undefined), false);
  assert.throws(() => compareThrows('rock', 'lizard'), /not a throw/);
});

test('a round names its winner, and a tie names nobody', () => {
  const win = resolveRound({ id: 'u_a', choice: 'rock' }, { id: 'u_b', choice: 'scissors' });
  assert.equal(win.winner, 'u_a');
  assert.equal(win.tie, false);
  assert.deepEqual(win.throws, { u_a: 'rock', u_b: 'scissors' });

  const loss = resolveRound({ id: 'u_a', choice: 'rock' }, { id: 'u_b', choice: 'paper' });
  assert.equal(loss.winner, 'u_b');

  const tie = resolveRound({ id: 'u_a', choice: 'paper' }, { id: 'u_b', choice: 'paper' });
  assert.equal(tie.winner, null);
  assert.equal(tie.tie, true);
});

test('the match ends only when someone reaches the target', () => {
  assert.equal(matchWinner({ u_a: 0, u_b: 0 }, 2), null);
  assert.equal(matchWinner({ u_a: 1, u_b: 1 }, 2), null, 'ties can drag it out past three rounds');
  assert.equal(matchWinner({ u_a: 2, u_b: 1 }, 2), 'u_a');
  assert.equal(matchWinner({ u_a: 1, u_b: 2 }, 2), 'u_b');
});

// ────────────────────────────────────────────────────────────  dice

test('/roll reads its shorthand', () => {
  assert.deepEqual(parseRollCommand('/roll'), { dice: 1, sides: 6 }, 'a bare roll is one d6');
  assert.deepEqual(parseRollCommand('/roll d20'), { dice: 1, sides: 20 });
  assert.deepEqual(parseRollCommand('/roll 3d6'), { dice: 3, sides: 6 });
  assert.deepEqual(parseRollCommand('  /ROLL 2d10  '), { dice: 2, sides: 10 }, 'case and space are forgiven');
});

test('anything that is not a roll is left alone as ordinary text', () => {
  assert.equal(parseRollCommand('hello'), null);
  assert.equal(parseRollCommand('let us /roll for it'), null, 'it has to start the message');
  assert.equal(looksLikeRoll('hello'), false);
  assert.equal(looksLikeRoll('/roll 3d6'), true);
  assert.equal(looksLikeRoll('/rolling'), false);
});

test('impossible dice are refused with a reason, not silently fudged', () => {
  assert.throws(() => parseRollCommand('/roll 0d6'), new RegExp(`between 1 and ${MAX_DICE}`));
  assert.throws(() => parseRollCommand(`/roll ${MAX_DICE + 1}d6`), new RegExp(`between 1 and ${MAX_DICE}`));
  assert.throws(() => parseRollCommand('/roll 1d1'), new RegExp(`between 2 and ${MAX_SIDES}`));
  assert.throws(() => parseRollCommand(`/roll 1d${MAX_SIDES + 1}`), new RegExp(`between 2 and ${MAX_SIDES}`));
});

test('rolling adds up, and stays inside the die', () => {
  // Injected randomness: the die always shows its highest face.
  const highest = rollDice(3, 6, (max) => max - 1);
  assert.deepEqual(highest.values, [6, 6, 6]);
  assert.equal(highest.total, 18);
  assert.equal(highest.notation, '3d6');

  const lowest = rollDice(2, 20, () => 0);
  assert.deepEqual(lowest.values, [1, 1]);
  assert.equal(lowest.total, 2);
});

test('real rolls never leave the range, over many tries', () => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const roll = rollDice(4, 6);
    assert.equal(roll.values.length, 4);
    assert.ok(roll.values.every((v) => Number.isInteger(v) && v >= 1 && v <= 6), roll.values.join());
    assert.equal(roll.total, roll.values.reduce((a, b) => a + b, 0));
  }

  // Over enough d6 rolls every face should turn up; a die stuck on one number
  // is the classic broken-random bug.
  const seen = new Set();
  for (let attempt = 0; attempt < 600; attempt++) seen.add(rollDice(1, 6).values[0]);
  assert.equal(seen.size, 6, `only saw ${[...seen].sort().join()}`);
});

test('a roll describes itself the same way it reads out loud', () => {
  assert.equal(describeRoll(rollDice(1, 6, () => 3)), '🎲 1d6: 4');
  assert.equal(describeRoll(rollDice(3, 6, () => 3)), '🎲 3d6: 4 + 4 + 4 = 12');
});
