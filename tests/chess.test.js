import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findMove,
  gameStatus,
  initialPosition,
  isInCheck,
  isInsufficientMaterial,
  legalMoves,
  makeMove,
  moveToSan,
  parseFen,
  parseSquare,
  repetitionKey,
  squareName,
  toFen,
} from '../server/chess.js';

/** Count every leaf of the move tree. The standard way to prove a generator. */
function perft(position, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(position);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) nodes += perft(makeMove(position, move), depth - 1);
  return nodes;
}

/** Play a list of algebraic moves like ['e2e4', 'e7e5'] and return the position. */
function play(fen, ...moves) {
  let position = fen ? parseFen(fen) : initialPosition();
  for (const text of moves) {
    const from = parseSquare(text.slice(0, 2));
    const to = parseSquare(text.slice(2, 4));
    const move = findMove(position, from, to, text[4] ?? null);
    assert.ok(move, `expected ${text} to be legal in ${toFen(position)}`);
    position = makeMove(position, move);
  }
  return position;
}

const sanOf = (position, text) => {
  const move = findMove(position, parseSquare(text.slice(0, 2)), parseSquare(text.slice(2, 4)), text[4] ?? null);
  assert.ok(move, `${text} should be legal`);
  return moveToSan(position, move);
};

// ─────────────────────────────────────────────────── perft (the real proof)

const PERFT_CASES = [
  ['initial position', null, [20, 400, 8902, 197281]],
  ['kiwipete: castling and en passant',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['pawn endgame with pins', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['promotion tangle',
    'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['knight fork and castling rights',
    'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['quiet middlegame',
    'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
];

for (const [name, fen, counts] of PERFT_CASES) {
  test(`perft — ${name}`, () => {
    const position = fen ? parseFen(fen) : initialPosition();
    counts.forEach((expected, index) => {
      assert.equal(perft(position, index + 1), expected, `depth ${index + 1}`);
    });
  });
}

// ──────────────────────────────────────────────────────────── FEN & squares

test('FEN round-trips and squares map both ways', () => {
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  assert.equal(toFen(parseFen(fen)), fen);
  assert.equal(toFen(initialPosition()), 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');

  assert.equal(squareName(0), 'a8');
  assert.equal(squareName(63), 'h1');
  assert.equal(parseSquare('e4'), 36);
  assert.equal(squareName(parseSquare('e4')), 'e4');
});

// ──────────────────────────────────────────────────────────── check & mate

test("fool's mate is a checkmate, and the game is over", () => {
  const position = play(null, 'f2f3', 'e7e5', 'g2g4', 'd8h4');
  assert.equal(isInCheck(position), true);
  assert.equal(legalMoves(position).length, 0);

  const status = gameStatus(position);
  assert.equal(status.state, 'checkmate');
  assert.equal(status.winner, 'b');
});

test('stalemate is not a loss', () => {
  const position = parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(isInCheck(position), false, 'the king is not attacked');
  assert.equal(legalMoves(position).length, 0, 'but it has nowhere to go');
  assert.equal(gameStatus(position).state, 'stalemate');
});

test('you may not leave your own king in check', () => {
  // The rook on e8 pins the bishop on e2 against the king on e1.
  const position = parseFen('4r2k/8/8/8/8/8/4B3/4K3 w - - 0 1');
  const bishopMoves = legalMoves(position).filter((m) => m.from === parseSquare('e2'));
  assert.equal(bishopMoves.length, 0, 'a pinned piece cannot step off the pin line');
});

test('check must be answered', () => {
  const position = parseFen('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  assert.equal(isInCheck(position), true);
  assert.equal(gameStatus(position).state, 'checkmate', "it is fool's mate, so there is no answer");
});

// ───────────────────────────────────────────────────────────── en passant

test('en passant is available for exactly one move', () => {
  let position = play(null, 'e2e4', 'a7a6', 'e4e5', 'd7d5');
  assert.equal(toFen(position).split(' ')[3], 'd6', 'the skipped square is the target');

  const capture = findMove(position, parseSquare('e5'), parseSquare('d6'));
  assert.ok(capture, 'the capture is offered');
  assert.equal(capture.enPassant, true);

  const after = makeMove(position, capture);
  assert.equal(after.board[parseSquare('d5')], '.', 'the captured pawn leaves the board');
  assert.equal(after.board[parseSquare('d6')], 'P');

  // Decline it, and the chance is gone.
  position = play(null, 'e2e4', 'a7a6', 'e4e5', 'd7d5', 'a2a3', 'a6a5');
  assert.equal(findMove(position, parseSquare('e5'), parseSquare('d6')), null);
});

// ────────────────────────────────────────────────────────────── castling

test('castling moves the rook too, and only when it is allowed', () => {
  const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';

  const short = play(fen, 'e1g1');
  assert.equal(short.board[parseSquare('g1')], 'K');
  assert.equal(short.board[parseSquare('f1')], 'R', 'the rook jumps to f1');
  assert.equal(short.board[parseSquare('h1')], '.');
  assert.equal(short.castling, 'kq', 'white has spent both rights');

  const long = play(fen, 'e1c1');
  assert.equal(long.board[parseSquare('c1')], 'K');
  assert.equal(long.board[parseSquare('d1')], 'R');
});

test('castling is refused out of, through, and into check', () => {
  // A rook on e8 attacks e1: the king is in check.
  assert.equal(findMove(parseFen('4r3/8/8/8/8/8/8/R3K2R w KQ - 0 1'), parseSquare('e1'), parseSquare('g1')), null);
  // A rook on f8 attacks f1, the square the king passes through.
  assert.equal(findMove(parseFen('5r2/8/8/8/8/8/8/R3K2R w KQ - 0 1'), parseSquare('e1'), parseSquare('g1')), null);
  // A rook on g8 attacks g1, where the king would land.
  assert.equal(findMove(parseFen('6r1/8/8/8/8/8/8/R3K2R w KQ - 0 1'), parseSquare('e1'), parseSquare('g1')), null);
  // A rook on b8 attacks b1 -- the rook's path, not the king's. Long castling is fine.
  assert.ok(findMove(parseFen('1r6/8/8/8/8/8/8/R3K2R w KQ - 0 1'), parseSquare('e1'), parseSquare('c1')));
});

test('moving the king or a rook gives up the right permanently', () => {
  const fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  assert.equal(play(fen, 'e1e2').castling, 'kq', 'the king move costs both white rights');
  assert.equal(play(fen, 'h1h2').castling, 'Qkq', 'the h1 rook costs the kingside right');
  assert.equal(play(fen, 'a1a2').castling, 'Kkq', 'the a1 rook costs the queenside right');
});

test('capturing a rook on its home square removes that right', () => {
  // Both sides pay: a1 leaving costs White queenside, a8 dying costs Black queenside.
  const position = play('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'a1a8');
  assert.equal(position.castling, 'Kk');
});

// ───────────────────────────────────────────────────────────── promotion

test('a pawn reaching the last rank must become something', () => {
  const position = parseFen('8/P6k/8/8/8/8/8/7K w - - 0 1');
  const pushes = legalMoves(position).filter((m) => m.from === parseSquare('a7'));
  assert.deepEqual(pushes.map((m) => m.promotion).sort(), ['b', 'n', 'q', 'r'], 'four choices, no plain push');

  assert.equal(play('8/P6k/8/8/8/8/8/7K w - - 0 1', 'a7a8q').board[parseSquare('a8')], 'Q');
  assert.equal(play('8/P6k/8/8/8/8/8/7K w - - 0 1', 'a7a8n').board[parseSquare('a8')], 'N');
  // Black promotes to a lowercase piece.
  assert.equal(play('7k/8/8/8/8/8/p7/7K b - - 0 1', 'a2a1r').board[parseSquare('a1')], 'r');
});

// ────────────────────────────────────────────────────────────────── draws

test('insufficient material covers the four dead positions', () => {
  const dead = [
    '7k/8/8/8/8/8/8/7K w - - 0 1',           // bare kings
    '7k/8/8/8/8/8/8/6BK w - - 0 1',           // king and bishop
    '7k/8/8/8/8/8/8/6NK w - - 0 1',           // king and knight
    '1b5k/8/8/8/8/8/8/6BK w - - 0 1',         // bishops both on dark squares
  ];
  for (const fen of dead) {
    assert.equal(isInsufficientMaterial(parseFen(fen).board), true, fen);
    assert.equal(gameStatus(parseFen(fen)).state, 'draw', fen);
  }

  const alive = [
    '7k/8/8/8/8/8/P7/7K w - - 0 1',           // a pawn can still promote
    '7k/8/8/8/8/8/8/6RK w - - 0 1',           // a rook can mate
    '4b2k/8/8/8/8/8/8/6BK w - - 0 1',         // bishops on opposite colours
    '7k/8/8/8/8/8/8/5NNK w - - 0 1',          // two knights can mate (rarely)
  ];
  for (const fen of alive) {
    assert.equal(isInsufficientMaterial(parseFen(fen).board), false, fen);
  }
});

test('the fifty-move clock resets on a capture or a pawn move', () => {
  assert.equal(play(null, 'e2e4').halfmove, 0, 'pawn move');
  assert.equal(play(null, 'g1f3').halfmove, 1, 'knight move ticks');
  assert.equal(play(null, 'g1f3', 'g8f6', 'f3g1').halfmove, 3);

  const captured = play('7k/8/8/3p4/4P3/8/8/7K w - - 40 1', 'e4d5');
  assert.equal(captured.halfmove, 0, 'a capture resets it');

  const stalled = parseFen('7k/8/8/8/8/8/8/R6K w - - 100 60');
  assert.equal(gameStatus(stalled).reason, 'fifty-move');
});

test('threefold repetition is a draw once the position appears three times', () => {
  let position = initialPosition();
  const history = [repetitionKey(position)];
  // Shuffle both knights out and back, twice.
  for (const move of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) {
    position = play(toFen(position), move);
    history.push(repetitionKey(position));
  }
  assert.equal(history.filter((key) => key === history[0]).length, 3, 'the start has occurred three times');
  assert.equal(gameStatus(position, history).state, 'draw');
  assert.equal(gameStatus(position, history).reason, 'threefold-repetition');

  // Two occurrences is not yet a claim.
  assert.equal(gameStatus(position, history.slice(0, 5)).state, 'playing');
});

// ──────────────────────────────────────────────────────────────────── SAN

test('SAN reads like a scoresheet', () => {
  const start = initialPosition();
  assert.equal(sanOf(start, 'e2e4'), 'e4');
  assert.equal(sanOf(start, 'g1f3'), 'Nf3');

  const captures = parseFen('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2');
  assert.equal(sanOf(captures, 'e4d5'), 'exd5', 'pawn captures name their file');

  const castles = parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.equal(sanOf(castles, 'e1g1'), 'O-O');
  assert.equal(sanOf(castles, 'e1c1'), 'O-O-O');

  const promoting = parseFen('8/P6k/8/8/8/8/8/7K w - - 0 1');
  assert.equal(sanOf(promoting, 'a7a8q'), 'a8=Q', 'promotion names the square, then the piece');
  assert.equal(sanOf(promoting, 'a7a8n'), 'a8=N');

  // A promotion that does give check carries the marker too.
  const checking = parseFen('3k4/1P6/8/8/8/8/8/7K w - - 0 1');
  assert.equal(sanOf(checking, 'b7b8q'), 'b8=Q+');

  const mate = parseFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  assert.equal(sanOf(mate, 'a1a8'), 'Ra8#');
});

test('SAN disambiguates only when it has to', () => {
  // Knights on b1 and f1 can both reach d2 -- the file tells them apart.
  const twoKnights = parseFen('7k/8/8/8/8/8/8/1N3N1K w - - 0 1');
  assert.equal(sanOf(twoKnights, 'b1d2'), 'Nbd2');
  assert.equal(sanOf(twoKnights, 'f1d2'), 'Nfd2');

  // Rooks on a1 and a5 share a file, so the rank is what separates them.
  const twoRooks = parseFen('7k/8/8/R7/8/8/8/R6K w - - 0 1');
  assert.equal(sanOf(twoRooks, 'a1a3'), 'R1a3');
  assert.equal(sanOf(twoRooks, 'a5a3'), 'R5a3');

  // A lone knight needs no hint at all.
  assert.equal(sanOf(parseFen('7k/8/8/8/8/8/8/1N5K w - - 0 1'), 'b1d2'), 'Nd2');
});

test('findMove rejects illegal requests and defaults promotion to a queen', () => {
  const start = initialPosition();
  assert.equal(findMove(start, parseSquare('e2'), parseSquare('e5')), null, 'pawns do not jump three');
  assert.equal(findMove(start, parseSquare('e1'), parseSquare('e2')), null, 'the king is boxed in');

  const promoting = parseFen('8/P6k/8/8/8/8/8/7K w - - 0 1');
  assert.equal(findMove(promoting, parseSquare('a7'), parseSquare('a8')).promotion, 'q');
});
