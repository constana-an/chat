/**
 * Chess rules.
 *
 * Pure functions over a FEN-shaped position, in the same spirit as
 * notifications.js: no store, no clock, no I/O, so the rules can be argued
 * about (and perft-tested) without a server.
 *
 * Squares are 0..63 with 0 = a8 and 63 = h1, matching the order FEN is
 * written in. Pieces are single characters: uppercase white, lowercase black,
 * '.' for an empty square.
 */

const EMPTY = '.';
const WHITE = 'w';
const BLACK = 'b';

const FILES = 'abcdefgh';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const sq = (file, rank) => rank * 8 + file;
const fileOf = (square) => square % 8;
const rankOf = (square) => (square / 8) | 0;
const onBoard = (file, rank) => file >= 0 && file < 8 && rank >= 0 && rank < 8;

const isWhite = (piece) => piece !== EMPTY && piece === piece.toUpperCase();
const colorOf = (piece) => (piece === EMPTY ? null : isWhite(piece) ? WHITE : BLACK);
const other = (color) => (color === WHITE ? BLACK : WHITE);

/** "e4" -> square index. */
export function parseSquare(name) {
  const file = FILES.indexOf(name[0]);
  const rank = 8 - Number(name[1]);
  return onBoard(file, rank) ? sq(file, rank) : -1;
}

/** square index -> "e4" */
export const squareName = (square) => FILES[fileOf(square)] + (8 - rankOf(square));

// ─────────────────────────────────────────────────────────────── FEN

export function parseFen(fen = START_FEN) {
  const [placement, turn, castling, enPassant, halfmove, fullmove] = fen.trim().split(/\s+/);
  const board = new Array(64).fill(EMPTY);

  let square = 0;
  for (const ch of placement) {
    if (ch === '/') continue;
    if (ch >= '1' && ch <= '8') square += Number(ch);
    else board[square++] = ch;
  }

  return {
    board,
    turn: turn === BLACK ? BLACK : WHITE,
    castling: castling === '-' ? '' : castling,
    enPassant: enPassant === '-' ? null : parseSquare(enPassant),
    halfmove: Number(halfmove ?? 0),
    fullmove: Number(fullmove ?? 1),
  };
}

export function toFen(position) {
  let placement = '';
  for (let rank = 0; rank < 8; rank++) {
    let gap = 0;
    for (let file = 0; file < 8; file++) {
      const piece = position.board[sq(file, rank)];
      if (piece === EMPTY) gap++;
      else {
        if (gap) placement += gap;
        gap = 0;
        placement += piece;
      }
    }
    if (gap) placement += gap;
    if (rank < 7) placement += '/';
  }
  const castling = position.castling || '-';
  const enPassant = position.enPassant == null ? '-' : squareName(position.enPassant);
  return `${placement} ${position.turn} ${castling} ${enPassant} ${position.halfmove} ${position.fullmove}`;
}

/** Everything that must repeat for a threefold claim -- move counters excluded. */
export const repetitionKey = (position) => toFen(position).split(' ').slice(0, 4).join(' ');

export const initialPosition = () => parseFen(START_FEN);

// ──────────────────────────────────────────────────────── attack maps

const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];
const ROOK_RAYS = [[0, 1], [0, -1], [1, 0], [-1, 0]];
const BISHOP_RAYS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Is `target` attacked by any `byColor` piece? Used for check and castling. */
export function isSquareAttacked(board, target, byColor) {
  const file = fileOf(target);
  const rank = rankOf(target);
  const mine = (piece) => piece !== EMPTY && colorOf(piece) === byColor;

  // Pawns. A white pawn on a lower rank index attacks upward, so to find one
  // attacking `target` we look one rank *below* it.
  const pawnRank = byColor === WHITE ? rank + 1 : rank - 1;
  const pawn = byColor === WHITE ? 'P' : 'p';
  for (const df of [-1, 1]) {
    if (onBoard(file + df, pawnRank) && board[sq(file + df, pawnRank)] === pawn) return true;
  }

  for (const [df, dr] of KNIGHT_STEPS) {
    if (!onBoard(file + df, rank + dr)) continue;
    const piece = board[sq(file + df, rank + dr)];
    if (mine(piece) && piece.toLowerCase() === 'n') return true;
  }

  for (const [df, dr] of KING_STEPS) {
    if (!onBoard(file + df, rank + dr)) continue;
    const piece = board[sq(file + df, rank + dr)];
    if (mine(piece) && piece.toLowerCase() === 'k') return true;
  }

  const ray = (deltas, pieces) => {
    for (const [df, dr] of deltas) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const piece = board[sq(f, r)];
        if (piece !== EMPTY) {
          if (mine(piece) && pieces.includes(piece.toLowerCase())) return true;
          break;
        }
        f += df;
        r += dr;
      }
    }
    return false;
  };

  return ray(ROOK_RAYS, ['r', 'q']) || ray(BISHOP_RAYS, ['b', 'q']);
}

export function findKing(board, color) {
  const king = color === WHITE ? 'K' : 'k';
  return board.indexOf(king);
}

export function isInCheck(position, color = position.turn) {
  const king = findKing(position.board, color);
  return king !== -1 && isSquareAttacked(position.board, king, other(color));
}

// ────────────────────────────────────────────────────── move generation

const PROMOTIONS = ['q', 'r', 'b', 'n'];

/** Moves that follow piece geometry but may leave the king in check. */
function pseudoLegalMoves(position) {
  const { board, turn } = position;
  const moves = [];
  const add = (from, to, extra = {}) => moves.push({ from, to, ...extra });

  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (piece === EMPTY || colorOf(piece) !== turn) continue;

    const file = fileOf(from);
    const rank = rankOf(from);
    const kind = piece.toLowerCase();
    const enemy = (square) => board[square] !== EMPTY && colorOf(board[square]) !== turn;
    const free = (square) => board[square] === EMPTY;

    if (kind === 'p') {
      const dr = turn === WHITE ? -1 : 1;
      const startRank = turn === WHITE ? 6 : 1;
      const lastRank = turn === WHITE ? 0 : 7;

      const ahead = rank + dr;
      if (onBoard(file, ahead) && free(sq(file, ahead))) {
        if (ahead === lastRank) for (const p of PROMOTIONS) add(from, sq(file, ahead), { promotion: p });
        else {
          add(from, sq(file, ahead));
          const twoAhead = rank + 2 * dr;
          if (rank === startRank && free(sq(file, twoAhead))) {
            add(from, sq(file, twoAhead), { double: true });
          }
        }
      }

      for (const df of [-1, 1]) {
        if (!onBoard(file + df, ahead)) continue;
        const target = sq(file + df, ahead);
        if (enemy(target)) {
          if (ahead === lastRank) for (const p of PROMOTIONS) add(from, target, { promotion: p });
          else add(from, target);
        } else if (target === position.enPassant) {
          add(from, target, { enPassant: true });
        }
      }
      continue;
    }

    if (kind === 'n' || kind === 'k') {
      for (const [df, dr] of kind === 'n' ? KNIGHT_STEPS : KING_STEPS) {
        if (!onBoard(file + df, rank + dr)) continue;
        const target = sq(file + df, rank + dr);
        if (free(target) || enemy(target)) add(from, target);
      }
      continue;
    }

    const rays = kind === 'r' ? ROOK_RAYS : kind === 'b' ? BISHOP_RAYS : [...ROOK_RAYS, ...BISHOP_RAYS];
    for (const [df, dr] of rays) {
      let f = file + df;
      let r = rank + dr;
      while (onBoard(f, r)) {
        const target = sq(f, r);
        if (free(target)) add(from, target);
        else {
          if (enemy(target)) add(from, target);
          break;
        }
        f += df;
        r += dr;
      }
    }
  }

  addCastlingMoves(position, moves);
  return moves;
}

function addCastlingMoves(position, moves) {
  const { board, turn, castling } = position;
  const home = turn === WHITE ? 7 : 0;
  const king = sq(4, home);
  if (board[king] !== (turn === WHITE ? 'K' : 'k')) return;
  // Castling out of check is illegal, and it is the one condition that makes
  // every candidate below moot -- check it once.
  if (isSquareAttacked(board, king, other(turn))) return;

  const rights = turn === WHITE ? ['K', 'Q'] : ['k', 'q'];
  const plans = [
    { right: rights[0], rookFile: 7, empty: [5, 6], safe: [5, 6], kingTo: 6 },
    { right: rights[1], rookFile: 0, empty: [1, 2, 3], safe: [2, 3], kingTo: 2 },
  ];

  for (const plan of plans) {
    if (!castling.includes(plan.right)) continue;
    if (board[sq(plan.rookFile, home)] !== (turn === WHITE ? 'R' : 'r')) continue;
    if (plan.empty.some((file) => board[sq(file, home)] !== EMPTY)) continue;
    // The king may not pass through an attacked square, but the rook may.
    if (plan.safe.some((file) => isSquareAttacked(board, sq(file, home), other(turn)))) continue;
    moves.push({ from: king, to: sq(plan.kingTo, home), castle: plan.right });
  }
}

/** Every move that is actually allowed: geometry, then "does it leave me in check". */
export function legalMoves(position) {
  return pseudoLegalMoves(position).filter((move) => !isInCheck(makeMove(position, move), position.turn));
}

const CASTLE_LOST = {
  [sq(4, 7)]: 'KQ', [sq(0, 7)]: 'Q', [sq(7, 7)]: 'K',   // white king / a1 / h1
  [sq(4, 0)]: 'kq', [sq(0, 0)]: 'q', [sq(7, 0)]: 'k',   // black king / a8 / h8
};

/** Apply a move. Returns a new position; the input is untouched. */
export function makeMove(position, move) {
  const board = position.board.slice();
  const piece = board[move.from];
  const kind = piece.toLowerCase();
  const captured = move.enPassant
    ? board[sq(fileOf(move.to), rankOf(move.from))]
    : board[move.to];

  board[move.from] = EMPTY;
  board[move.to] = move.promotion
    ? (position.turn === WHITE ? move.promotion.toUpperCase() : move.promotion)
    : piece;

  if (move.enPassant) board[sq(fileOf(move.to), rankOf(move.from))] = EMPTY;

  if (move.castle) {
    const home = rankOf(move.from);
    const [rookFrom, rookTo] = fileOf(move.to) === 6 ? [7, 5] : [0, 3];
    board[sq(rookTo, home)] = board[sq(rookFrom, home)];
    board[sq(rookFrom, home)] = EMPTY;
  }

  // Moving a king or rook, or capturing a rook on its home square, ends rights.
  let castling = position.castling;
  for (const square of [move.from, move.to]) {
    const lost = CASTLE_LOST[square];
    if (lost) castling = [...castling].filter((right) => !lost.includes(right)).join('');
  }

  return {
    board,
    turn: other(position.turn),
    castling,
    enPassant: move.double ? sq(fileOf(move.from), (rankOf(move.from) + rankOf(move.to)) / 2) : null,
    // The fifty-move clock resets on a pawn move or a capture.
    halfmove: kind === 'p' || captured !== EMPTY ? 0 : position.halfmove + 1,
    fullmove: position.turn === BLACK ? position.fullmove + 1 : position.fullmove,
  };
}

/** Find the legal move matching a from/to (and promotion) request, or null. */
export function findMove(position, from, to, promotion = null) {
  const candidates = legalMoves(position).filter((move) => move.from === from && move.to === to);
  if (!candidates.length) return null;
  if (candidates.length === 1 && !candidates[0].promotion) return candidates[0];
  return candidates.find((move) => move.promotion === (promotion ?? 'q')) ?? null;
}

// ─────────────────────────────────────────────────────────── outcomes

/** Neither side can ever mate: K vs K, K+B vs K, K+N vs K, or same-colour bishops. */
export function isInsufficientMaterial(board) {
  const pieces = [];
  for (let square = 0; square < 64; square++) {
    const piece = board[square];
    if (piece !== EMPTY && piece.toLowerCase() !== 'k') pieces.push({ piece: piece.toLowerCase(), square });
  }
  if (pieces.length === 0) return true;
  if (pieces.some((p) => p.piece === 'p' || p.piece === 'r' || p.piece === 'q')) return false;
  if (pieces.length === 1) return true; // lone bishop or knight
  if (pieces.every((p) => p.piece === 'b')) {
    const colors = new Set(pieces.map((p) => (fileOf(p.square) + rankOf(p.square)) % 2));
    return colors.size === 1;
  }
  return false;
}

/**
 * @param {object} position
 * @param {string[]} [history] repetition keys of every position that has occurred,
 *   including the current one.
 * @returns {{state: 'playing'|'check'|'checkmate'|'stalemate'|'draw', winner?: 'w'|'b', reason?: string}}
 */
export function gameStatus(position, history = []) {
  const moves = legalMoves(position);
  const inCheck = isInCheck(position);

  if (moves.length === 0) {
    return inCheck
      ? { state: 'checkmate', winner: other(position.turn), reason: 'checkmate' }
      : { state: 'stalemate', reason: 'stalemate' };
  }
  if (isInsufficientMaterial(position.board)) {
    return { state: 'draw', reason: 'insufficient-material' };
  }
  if (position.halfmove >= 100) {
    return { state: 'draw', reason: 'fifty-move' };
  }
  const key = repetitionKey(position);
  if (history.filter((entry) => entry === key).length >= 3) {
    return { state: 'draw', reason: 'threefold-repetition' };
  }
  return inCheck ? { state: 'check' } : { state: 'playing' };
}

// ─────────────────────────────────────────────────────────────── SAN

/** Standard algebraic notation, so the move list reads like a scoresheet. */
export function moveToSan(position, move) {
  if (move.castle) {
    const base = fileOf(move.to) === 6 ? 'O-O' : 'O-O-O';
    return base + suffix(position, move);
  }

  const piece = position.board[move.from];
  const kind = piece.toLowerCase();
  const captures = position.board[move.to] !== EMPTY || Boolean(move.enPassant);

  let text;
  if (kind === 'p') {
    text = captures ? `${FILES[fileOf(move.from)]}x${squareName(move.to)}` : squareName(move.to);
    if (move.promotion) text += `=${move.promotion.toUpperCase()}`;
  } else {
    text = kind.toUpperCase() + disambiguate(position, move) + (captures ? 'x' : '') + squareName(move.to);
  }
  return text + suffix(position, move);
}

/** Only add a file/rank hint when another identical piece could also go there. */
function disambiguate(position, move) {
  const piece = position.board[move.from];
  const rivals = legalMoves(position).filter(
    (other) => other.to === move.to && other.from !== move.from && position.board[other.from] === piece,
  );
  if (!rivals.length) return '';
  const sameFile = rivals.some((other) => fileOf(other.from) === fileOf(move.from));
  const sameRank = rivals.some((other) => rankOf(other.from) === rankOf(move.from));
  if (!sameFile) return FILES[fileOf(move.from)];
  if (!sameRank) return String(8 - rankOf(move.from));
  return squareName(move.from);
}

function suffix(position, move) {
  const next = makeMove(position, move);
  if (!isInCheck(next)) return '';
  return legalMoves(next).length === 0 ? '#' : '+';
}

export { START_FEN, WHITE, BLACK, EMPTY, colorOf, other };
