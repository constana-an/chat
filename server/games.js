/**
 * The two small games: rock-paper-scissors, and dice.
 *
 * Pure functions, with randomness injected, so both can be tested without a
 * server and without hoping the coin lands the right way -- the same shape as
 * notifications.js and chess.js.
 */

import crypto from 'node:crypto';

// ────────────────────────────────────────────── rock, paper, scissors

export const RPS_CHOICES = ['rock', 'paper', 'scissors'];

/** rock crushes scissors, scissors cuts paper, paper covers rock. */
const BEATS = { rock: 'scissors', scissors: 'paper', paper: 'rock' };

export const isChoice = (value) => RPS_CHOICES.includes(value);

/** @returns 1 if `a` wins, -1 if `b` wins, 0 for a tie. */
export function compareThrows(a, b) {
  if (!isChoice(a) || !isChoice(b)) throw new Error(`not a throw: ${a} / ${b}`);
  if (a === b) return 0;
  return BEATS[a] === b ? 1 : -1;
}

/**
 * Resolve one round between two players.
 * @param {{id: string, choice: string}} first
 * @param {{id: string, choice: string}} second
 * @returns {{throws: Record<string,string>, winner: string|null, tie: boolean}}
 */
export function resolveRound(first, second) {
  const verdict = compareThrows(first.choice, second.choice);
  return {
    throws: { [first.id]: first.choice, [second.id]: second.choice },
    winner: verdict === 0 ? null : verdict > 0 ? first.id : second.id,
    tie: verdict === 0,
  };
}

/**
 * Who, if anyone, has taken the match? A tie scores for nobody, so a
 * best-of-three can run past three rounds -- `target` wins is the real end.
 */
export function matchWinner(scores, target) {
  return Object.entries(scores).find(([, wins]) => wins >= target)?.[0] ?? null;
}

// ────────────────────────────────────────────────────────────── dice

const ROLL_PATTERN = /^\/roll(?:\s+(\d*)d(\d+))?\s*$/i;

export const MAX_DICE = 10;
export const MAX_SIDES = 1000;

/**
 * Read a `/roll`, `/roll d20` or `/roll 3d6` composer command.
 * @returns {{dice: number, sides: number} | null} null when it is not a roll,
 *   or throws when it is a roll but an impossible one.
 */
export function parseRollCommand(text) {
  const match = ROLL_PATTERN.exec(String(text ?? '').trim());
  if (!match) return null;

  const dice = match[1] ? Number(match[1]) : 1;
  const sides = match[2] ? Number(match[2]) : 6;

  if (dice < 1 || dice > MAX_DICE) {
    throw new Error(`Roll between 1 and ${MAX_DICE} dice.`);
  }
  if (sides < 2 || sides > MAX_SIDES) {
    throw new Error(`Dice need between 2 and ${MAX_SIDES} sides.`);
  }
  return { dice, sides };
}

/** Does this text look like a roll attempt at all? Used to report bad ones. */
export const looksLikeRoll = (text) => /^\/roll\b/i.test(String(text ?? '').trim());

/**
 * @param {number} dice
 * @param {number} sides
 * @param {(max: number) => number} [random] returns 0..max-1; injected for tests.
 */
export function rollDice(dice, sides, random = (max) => crypto.randomInt(max)) {
  const values = [];
  for (let i = 0; i < dice; i++) values.push(random(sides) + 1);
  return {
    dice,
    sides,
    values,
    total: values.reduce((sum, value) => sum + value, 0),
    notation: `${dice}d${sides}`,
  };
}

/** "ada rolled 3d6: 4 + 1 + 6 = 11" -- also the fallback text for old clients. */
export function describeRoll(roll) {
  const detail = roll.values.length > 1 ? `${roll.values.join(' + ')} = ${roll.total}` : String(roll.total);
  return `🎲 ${roll.notation}: ${detail}`;
}
