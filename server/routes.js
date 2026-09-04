/**
 * HTTP API.
 *
 * Sessions are bearer tokens sent in the Authorization header (not cookies),
 * so you can be logged in as a different user in every browser tab -- which is
 * what makes this app testable by one person.
 */

import crypto from 'node:crypto';

import { httpError, publicMessage, publicUser } from './store.js';
import { isChannelMuted, isQuietHoursActive, mutedUntil, routeMessage } from './notifications.js';
import {
  findMove,
  gameStatus,
  isInCheck,
  legalMoves,
  makeMove,
  moveToSan,
  parseFen,
  repetitionKey,
  squareName,
  toFen,
} from './chess.js';
import { isChoice, matchWinner, resolveRound } from './games.js';

export function createRouter({ store, hub }) {
  const routes = [
    ['POST', /^\/api\/session$/, createSession],
    ['GET', /^\/api\/session$/, currentSession],
    ['DELETE', /^\/api\/session$/, endSession],

    ['GET', /^\/api\/state$/, getState],
    ['GET', /^\/api\/users$/, getUsers],
    ['GET', /^\/api\/events$/, streamEvents],

    ['POST', /^\/api\/channels$/, createChannel],
    ['POST', /^\/api\/channels\/([\w]+)\/join$/, joinChannel],
    ['POST', /^\/api\/channels\/([\w]+)\/leave$/, leaveChannel],
    ['GET', /^\/api\/channels\/([\w]+)\/messages$/, getChannelMessages],
    ['POST', /^\/api\/channels\/([\w]+)\/messages$/, postChannelMessage],
    ['PATCH', /^\/api\/channels\/([\w]+)\/prefs$/, setChannelPrefs],

    ['GET', /^\/api\/dms\/([\w]+)\/messages$/, getDirectMessages],
    ['POST', /^\/api\/dms\/([\w]+)\/messages$/, postDirectMessage],

    ['POST', /^\/api\/games$/, challenge],
    ['GET', /^\/api\/games\/([\w]+)$/, getGame],
    ['POST', /^\/api\/games\/([\w]+)\/accept$/, acceptGame],
    ['POST', /^\/api\/games\/([\w]+)\/decline$/, declineGame],
    ['POST', /^\/api\/games\/([\w]+)\/moves$/, playMove],
    ['POST', /^\/api\/games\/([\w]+)\/throw$/, throwRps],
    ['POST', /^\/api\/games\/([\w]+)\/resign$/, resignGame],

    ['GET', /^\/api\/scheduled$/, listScheduled],
    ['DELETE', /^\/api\/scheduled\/([\w]+)$/, cancelScheduled],

    ['POST', /^\/api\/read$/, markRead],
    ['GET', /^\/api\/notifications$/, getNotifications],
    ['POST', /^\/api\/notifications\/read$/, readNotifications],
    ['PATCH', /^\/api\/settings\/quiet-hours$/, setQuietHours],
    ['PATCH', /^\/api\/settings\/digest$/, setDigest],
  ];

  function match(method, pathname) {
    for (const [routeMethod, pattern, handler] of routes) {
      if (routeMethod !== method) continue;
      const m = pattern.exec(pathname);
      if (m) return { handler, params: m.slice(1) };
    }
    return null;
  }

  // ------------------------------------------------------------------ session

  async function createSession({ body }) {
    const { user, created, claimed } = await store.authenticate({
      username: body.username,
      password: body.password,
    });
    const token = store.createSession(user.id);

    if (created) {
      // Tell everyone already connected that a new person exists, so mention
      // autocomplete and the DM list pick them up without a reload.
      hub.broadcast(allUserIds().filter((otherId) => otherId !== user.id), 'user:joined', {
        user: publicUser(user, { online: false }),
      });
      // New members are auto-joined to the default channels; announce that too.
      for (const channelId of user.channels) {
        announceMembership(store.getChannel(channelId), user, 'joined');
      }
    }
    return { token, created, claimed, user: selfView(user) };
  }

  function currentSession({ user }) {
    requireAuth(user);
    return { user: selfView(user) };
  }

  function endSession({ token }) {
    store.destroySession(token);
    return { ok: true };
  }

  // -------------------------------------------------------------------- state

  function getState({ user }) {
    requireAuth(user);
    return {
      user: selfView(user),
      users: store.listUsers().filter((u) => u.id !== user.id)
        .map((u) => publicUser(u, { online: store.isOnline(u.id) })),
      channels: channelViews(user),
      dms: store.listDmThreads(user.id).map((thread) => ({
        ...thread,
        game: gameSummary(user.id, store.activeGameIn(thread.conversationId, 'chess')),
        rps: rpsSummary(user.id, store.activeGameIn(thread.conversationId, 'rps')),
      })),
      notifications: store.listNotifications(user.id),
      scheduled: store.listScheduled(user.id),
      serverTime: Date.now(),
    };
  }

  function getUsers({ user }) {
    requireAuth(user);
    return {
      users: store.listUsers().map((u) => publicUser(u, { online: store.isOnline(u.id) })),
    };
  }

  // ----------------------------------------------------------------- channels

  function createChannel({ user, body }) {
    requireAuth(user);
    const channel = store.createChannel({
      name: body.name,
      topic: body.topic ?? '',
      createdBy: user.id,
    });
    // Everyone can see public channels in the browse list...
    hub.broadcast(allUserIds(), 'channel:created', { channel: channelSummary(channel) });
    // ...and the creator is auto-joined, which their other tabs need to hear about.
    announceMembership(channel, user, 'joined');
    return { channel: channelView(user, channel) };
  }

  function joinChannel({ user, params }) {
    requireAuth(user);
    const channel = store.joinChannel(user.id, params[0]);
    announceMembership(channel, user, 'joined');
    return { channel: channelView(user, channel) };
  }

  function leaveChannel({ user, params }) {
    requireAuth(user);
    const channel = store.leaveChannel(user.id, params[0]);
    announceMembership(channel, user, 'left');
    return { channel: channelView(user, channel) };
  }

  function announceMembership(channel, user, action) {
    hub.broadcast(allUserIds(), 'channel:membership', {
      channelId: channel.id,
      channelName: channel.name,
      memberCount: channel.members.size,
      userId: user.id,
      username: user.name,
      action,
    });
  }

  function getChannelMessages({ user, params, url }) {
    requireAuth(user);
    const channel = store.getChannel(params[0]);
    if (!channel) throw httpError(404, 'Unknown channel.');
    return {
      messages: store.history(channel.id, {
        before: url.searchParams.get('before'),
        limit: Number(url.searchParams.get('limit') ?? 60),
      }),
      ...store.unreadFor(user.id, channel.id),
    };
  }

  function postChannelMessage({ user, params, body }) {
    requireAuth(user);
    if (body.deliverAt != null) {
      return scheduleFor(user, {
        kind: 'channel', channelId: params[0], text: body.text, deliverAt: body.deliverAt,
      });
    }
    const message = store.postChannelMessage({
      channelId: params[0],
      authorId: user.id,
      text: body.text,
    });
    const channel = store.getChannel(params[0]);
    deliver({ message, channel, recipients: [...channel.members] });
    return { message: publicMessage(message) };
  }

  function setChannelPrefs({ user, params, body }) {
    requireAuth(user);
    const channelId = params[0];
    if ('muted' in body) {
      store.setChannelMute(user.id, channelId, Boolean(body.muted), body.minutes ?? null);
    }
    const channel = store.getChannel(channelId);
    hub.send(user.id, 'prefs', { channels: channelViews(user), quietHours: user.prefs.quietHours });
    return { channel: channelView(user, channel) };
  }

  // ------------------------------------------------------------ direct messages

  function getDirectMessages({ user, params, url }) {
    requireAuth(user);
    const other = store.getUser(params[0]);
    if (!other) throw httpError(404, 'Unknown user.');
    const conversationId = store.dmConversationId(user.id, other.id);
    store.ensureDmConversation(user.id, other.id);
    return {
      conversationId,
      withUser: publicUser(other, { online: store.isOnline(other.id) }),
      messages: store.history(conversationId, {
        before: url.searchParams.get('before'),
        limit: Number(url.searchParams.get('limit') ?? 60),
      }),
      ...store.unreadFor(user.id, conversationId),
    };
  }

  function postDirectMessage({ user, params, body }) {
    requireAuth(user);
    const other = store.getUser(params[0]);
    if (!other) throw httpError(404, 'Unknown user.');
    if (body.deliverAt != null) {
      return scheduleFor(user, { kind: 'direct', toId: other.id, text: body.text, deliverAt: body.deliverAt });
    }
    const message = store.postDirectMessage({ fromId: user.id, toId: other.id, text: body.text });
    deliver({ message, channel: null, recipients: [user.id, other.id] });
    return { message: publicMessage(message) };
  }

  // ------------------------------------------------------------- scheduling

  let scheduler = null;

  function scheduleFor(user, spec) {
    const item = store.scheduleMessage({ authorId: user.id, ...spec });
    // A newly scheduled item may be sooner than whatever the timer was waiting for.
    scheduler?.armNext();
    hub.send(user.id, 'scheduled', { scheduled: store.listScheduled(user.id) });
    return { scheduled: item };
  }

  function listScheduled({ user }) {
    requireAuth(user);
    return { scheduled: store.listScheduled(user.id) };
  }

  function cancelScheduled({ user, params }) {
    requireAuth(user);
    const item = store.cancelScheduled(params[0], user.id);
    scheduler?.armNext();
    hub.send(user.id, 'scheduled', { scheduled: store.listScheduled(user.id) });
    return { cancelled: item.id };
  }

  /**
   * What the scheduler calls when a message comes due.
   *
   * It runs the *ordinary* post path — nothing about delivery, mentions or
   * unread counting is special-cased for having been scheduled. That is the
   * whole point of holding the write back rather than writing early and
   * hiding it: mentions resolve now, seq is allocated now, unread starts now.
   */
  async function deliverScheduled(item) {
    if (item.kind === 'channel') {
      const message = store.postChannelMessage({
        channelId: item.channelId, authorId: item.authorId, text: item.text,
      });
      const channel = store.getChannel(item.channelId);
      deliver({ message, channel, recipients: [...channel.members] });
    } else {
      const message = store.postDirectMessage({
        fromId: item.authorId, toId: item.toId, text: item.text,
      });
      deliver({ message, channel: null, recipients: [item.authorId, item.toId] });
    }
    hub.send(item.authorId, 'scheduled', { scheduled: store.listScheduled(item.authorId) });
  }

  // ---------------------------------------------------------------- delivery

  /**
   * Fan a new message out to its audience: everyone gets the message and a
   * refreshed unread count; only DMs and @mentions produce a notification.
   */
  function deliver({ message, channel, recipients }) {
    const now = new Date();
    const payloadMessage = publicMessage(message);

    const audience = [...new Set(recipients)];

    for (const recipientId of audience) {
      const recipient = store.getUser(recipientId);
      if (!recipient) continue;

      // For a DM, tell each side who the thread is *with* — conversation ids
      // are opaque and must not be parsed by the client.
      const partnerId = message.scope === 'direct'
        ? audience.find((otherId) => otherId !== recipientId) ?? recipientId
        : null;

      const isAuthor = recipientId === message.authorId;
      const decision = routeMessage({
        scope: message.scope,
        recipient,
        mentions: message.mentions,
        channelId: channel?.id,
        now,
      });

      hub.send(recipientId, 'message', {
        message: payloadMessage,
        channel: channel ? { id: channel.id, name: channel.name } : null,
        direct: partnerId
          ? { userId: partnerId, username: store.getUser(partnerId)?.name ?? 'unknown' }
          : null,
        unread: {
          conversationId: message.conversationId,
          ...store.unreadFor(recipientId, message.conversationId),
        },
        muted: decision.channelMuted,
      });

      if (isAuthor || !decision.inbox) continue;

      const notification = store.addNotification(recipientId, {
        // Held items are invisible until the digest fires.
        pending: decision.delivery === 'digest',
        id: store.newId('n'),
        kind: decision.kind,
        conversationId: message.conversationId,
        messageId: message.id,
        scope: message.scope,
        from: { id: message.authorId, name: message.authorName },
        channel: channel ? { id: channel.id, name: channel.name } : null,
        preview: message.text.slice(0, 160),
        ts: message.ts,
        read: false,
        alert: decision.alert,
        bypassedMute: decision.bypassedMute,
        silencedByQuietHours: decision.silencedByQuietHours,
        reason: decision.reason,
      });

      // A held item is not pushed; the digest that collects it will be.
      if (decision.delivery === 'digest') {
        scheduler?.armNext();
        continue;
      }
      hub.send(recipientId, 'notification', { notification });
    }
  }

  /**
   * Send every digest that has come due.
   *
   * Quiet hours are evaluated **here**, at flush time, not when each item was
   * held — the digest is one notification, so it is the digest that is or is
   * not silenced. That is the only sensible answer to the two features
   * overlapping, and nothing in the per-item decision could have given it.
   */
  function flushDigests(now = Date.now()) {
    for (const userId of store.usersDueForDigest(now)) releaseDigest(userId, now);
  }

  /** Send one user's held items as a digest, whatever the reason for sending. */
  function releaseDigest(userId, now = Date.now()) {
    const user = store.getUser(userId);
    if (!user) return null;
    const quiet = isQuietHoursActive(user.prefs.quietHours, new Date(now));
    const digest = store.flushDigest(userId, now, { alert: !quiet, silencedByQuietHours: quiet });
    if (digest) hub.send(userId, 'notification', { notification: digest });
    return digest;
  }

  // -------------------------------------------------------------------- chess

  /**
   * A game lives in the direct-message thread between two people, so the thread
   * decides who may see and touch it. One live game per thread at a time.
   */
  function challenge({ user, body }) {
    requireAuth(user);
    const opponent = store.getUser(body.opponentId);
    if (!opponent) throw httpError(404, 'Unknown user.');
    if (opponent.id === user.id) throw httpError(400, 'You need someone to play against.');

    const conversationId = store.dmConversationId(user.id, opponent.id);
    store.ensureDmConversation(user.id, opponent.id);

    if (body.kind === 'rps') return startRps({ user, opponent, conversationId });

    if (store.activeGameIn(conversationId, 'chess')) {
      throw httpError(409, 'You already have a game going with them.');
    }

    // Colours are drawn, not chosen -- otherwise the challenger always picks white.
    const challengerIsWhite = crypto.randomInt(2) === 0;
    const game = store.createGame({
      conversationId,
      whiteId: challengerIsWhite ? user.id : opponent.id,
      blackId: challengerIsWhite ? opponent.id : user.id,
      createdBy: user.id,
    });

    announceGame(game);
    notifyAboutGame(game, opponent.id, {
      title: `${user.name} challenged you to chess`,
      preview: `You play ${game.white === opponent.id ? 'white' : 'black'}.`,
    });
    return { game: gameView(user.id, game) };
  }

  /**
   * Rock-paper-scissors needs no accept step -- it is one click to join in, so
   * the challenge simply starts the match.
   */
  function startRps({ user, opponent, conversationId }) {
    if (store.activeGameIn(conversationId, 'rps')) {
      throw httpError(409, 'You already have a round going with them.');
    }
    const game = store.createRpsGame({
      conversationId,
      players: [user.id, opponent.id],
      createdBy: user.id,
    });
    announceGame(game);
    notifyAboutGame(game, opponent.id, {
      title: `${user.name} started rock-paper-scissors`,
      preview: `First to ${game.target} wins. Pick one.`,
    });
    return { game: gameView(user.id, game) };
  }

  function throwRps({ user, params, body }) {
    requireAuth(user);
    const game = mustPlay(params[0], user);
    if (game.kind !== 'rps') throw httpError(400, 'That game is chess.');
    if (game.status !== 'active') throw httpError(409, 'That match is over.');
    if (!isChoice(body.choice)) throw httpError(400, 'Throw rock, paper or scissors.');
    if (game.throws[user.id]) throw httpError(409, 'You have already thrown this round.');

    game.throws[user.id] = body.choice;
    const opponentId = opponentOf(game, user.id);

    if (!game.throws[opponentId]) {
      // Only one throw is in. Save it, tell them it is their turn, and say
      // nothing about what it was.
      store.saveGame(game);
      announceGame(game);
      notifyAboutGame(game, opponentId, {
        title: 'Rock-paper-scissors',
        preview: `${user.name} has thrown. Your turn.`,
        replace: true,
      });
      return { game: gameView(user.id, game) };
    }

    const round = resolveRound(
      { id: user.id, choice: game.throws[user.id] },
      { id: opponentId, choice: game.throws[opponentId] },
    );
    game.rounds.push({ ...round, at: Date.now() });
    if (round.winner) game.scores[round.winner]++;
    game.throws = {};

    const champion = matchWinner(game.scores, game.target);
    if (champion) {
      finishRps(game, { state: 'won', winner: champion });
    } else {
      store.saveGame(game);
      announceGame(game);
      for (const playerId of game.players) {
        notifyAboutGame(game, playerId, {
          title: 'Rock-paper-scissors',
          preview: roundLine(game, playerId, round),
          replace: true,
        });
      }
    }
    return { game: gameView(user.id, game) };
  }

  function finishRps(game, result) {
    game.status = 'finished';
    game.result = result;
    store.saveGame(game);
    announceGame(game);
    for (const playerId of game.players) {
      notifyAboutGame(game, playerId, {
        title: 'Rock-paper-scissors ended',
        preview: result.winner === playerId
          ? `You win ${game.scores[playerId]}–${game.scores[opponentOf(game, playerId)]}.`
          : `You lose ${game.scores[playerId]}–${game.scores[opponentOf(game, playerId)]}.`,
      });
    }
  }

  function roundLine(game, playerId, round) {
    const mine = round.throws[playerId];
    const theirs = round.throws[opponentOf(game, playerId)];
    const verdict = round.tie ? 'a tie' : round.winner === playerId ? 'you win it' : 'you lose it';
    return `${mine} vs ${theirs} — ${verdict}. ${game.scores[playerId]}–${game.scores[opponentOf(game, playerId)]}.`;
  }

  function getGame({ user, params }) {
    requireAuth(user);
    return { game: gameView(user.id, mustPlay(params[0], user)) };
  }

  function acceptGame({ user, params }) {
    requireAuth(user);
    const game = mustPlay(params[0], user);
    if (game.status !== 'pending') throw httpError(409, 'That challenge is no longer open.');
    if (game.createdBy === user.id) throw httpError(403, 'Wait for them to accept.');

    game.status = 'active';
    store.saveGame(game);
    announceGame(game);
    // Whoever moves first should hear about it.
    const mover = game.white;
    if (mover !== user.id) notifyTurn(game, mover);
    return { game: gameView(user.id, game) };
  }

  function declineGame({ user, params }) {
    requireAuth(user);
    const game = mustPlay(params[0], user);
    if (game.status !== 'pending') throw httpError(409, 'That challenge is no longer open.');
    finish(game, { state: 'declined', reason: 'declined', by: user.id });
    return { game: gameView(user.id, game) };
  }

  function playMove({ user, params, body }) {
    requireAuth(user);
    const game = mustPlay(params[0], user);
    if (game.status !== 'active') throw httpError(409, 'That game is not running.');

    const position = parseFen(game.fen);
    const color = colorFor(game, user.id);
    if (color !== position.turn) throw httpError(409, 'It is not your move.');

    const from = squareIndex(body.from);
    const to = squareIndex(body.to);
    const move = findMove(position, from, to, body.promotion ?? null);
    // The server owns legality. A client cannot talk it into an illegal move.
    if (!move) throw httpError(400, 'That is not a legal move.');

    const san = moveToSan(position, move);
    const next = makeMove(position, move);

    game.fen = toFen(next);
    game.history.push(repetitionKey(next));
    game.lastMove = { from, to };
    game.moves.push({
      san,
      from,
      to,
      uci: squareName(from) + squareName(to) + (move.promotion ?? ''),
      by: user.id,
      ts: Date.now(),
    });

    const outcome = gameStatus(next, game.history);
    if (outcome.state === 'checkmate' || outcome.state === 'stalemate' || outcome.state === 'draw') {
      finish(game, outcome, san);
      return { game: gameView(user.id, game) };
    }

    store.saveGame(game);
    announceGame(game);
    notifyTurn(game, opponentOf(game, user.id), san, outcome.state === 'check');
    return { game: gameView(user.id, game) };
  }

  function resignGame({ user, params }) {
    requireAuth(user);
    const game = mustPlay(params[0], user);
    if (game.status === 'finished') throw httpError(409, 'That game is already over.');
    if (game.kind === 'rps') {
      finishRps(game, { state: 'resigned', winner: opponentOf(game, user.id), by: user.id });
      return { game: gameView(user.id, game) };
    }
    finish(game, {
      state: 'resigned',
      reason: 'resignation',
      winner: colorFor(game, opponentOf(game, user.id)),
      by: user.id,
    });
    return { game: gameView(user.id, game) };
  }

  function finish(game, result, san = null) {
    game.status = 'finished';
    game.result = result;
    store.saveGame(game);
    announceGame(game);

    for (const playerId of playersOf(game)) {
      notifyAboutGame(game, playerId, {
        title: 'Your chess game ended',
        preview: describeResult(game, playerId, result, san),
      });
    }
  }

  function describeResult(game, viewerId, result, san) {
    const mine = colorFor(game, viewerId);
    const opponentName = store.getUser(opponentOf(game, viewerId))?.name ?? 'your opponent';
    const prefix = san ? `${san} — ` : '';
    if (result.state === 'declined') return `${opponentName} declined the challenge.`;
    if (result.state === 'stalemate') return `${prefix}Stalemate. It is a draw.`;
    if (result.state === 'draw') return `${prefix}Draw by ${result.reason.replace(/-/g, ' ')}.`;
    if (result.state === 'resigned') {
      return result.by === viewerId ? 'You resigned.' : `${opponentName} resigned. You win.`;
    }
    return result.winner === mine ? `${prefix}Checkmate. You win.` : `${prefix}Checkmate. You lose.`;
  }

  function notifyTurn(game, playerId, san = null, check = false) {
    const opponentName = store.getUser(opponentOf(game, playerId))?.name ?? 'your opponent';
    notifyAboutGame(game, playerId, {
      title: 'Your move',
      preview: san ? `${opponentName} played ${san}${check ? ' — you are in check' : ''}.` : 'The game has started.',
      replace: true,
    });
  }

  /**
   * Games are between two people, so they notify like a direct message: channel
   * mutes cannot touch them, quiet hours can silence them. "Your move" replaces
   * itself so a long game leaves one entry rather than one per move.
   */
  function notifyAboutGame(game, playerId, { title, preview, replace = false }) {
    const player = store.getUser(playerId);
    if (!player) return;
    const decision = routeMessage({ scope: 'direct', recipient: player, mentions: [playerId] });

    const notification = {
      id: store.newId('n'),
      kind: 'direct',
      conversationId: game.conversationId,
      gameId: game.id,
      messageId: null,
      scope: 'direct',
      from: { id: opponentOf(game, playerId), name: store.getUser(opponentOf(game, playerId))?.name ?? 'chess' },
      channel: null,
      preview: `${(game.kind ?? 'chess') === 'rps' ? '✊' : '♟'} ${title} — ${preview}`,
      ts: Date.now(),
      read: false,
      alert: decision.alert,
      bypassedMute: false,
      silencedByQuietHours: decision.silencedByQuietHours,
      reason: decision.reason,
    };

    const stored = replace
      ? store.replaceGameNotification(playerId, game.id, notification)
      : store.addNotification(playerId, notification);
    hub.send(playerId, 'notification', { notification: stored });
  }

  function announceGame(game) {
    for (const playerId of playersOf(game)) {
      hub.send(playerId, 'game', { game: gameView(playerId, game) });
    }
  }

  function gameView(viewerId, game) {
    if ((game.kind ?? 'chess') === 'rps') return rpsView(viewerId, game);
    const position = parseFen(game.fen);
    const color = colorFor(game, viewerId);
    const yourTurn = game.status === 'active' && color === position.turn;

    return {
      id: game.id,
      kind: 'chess',
      conversationId: game.conversationId,
      status: game.status,
      result: game.result,
      white: playerStub(game.white),
      black: playerStub(game.black),
      fen: game.fen,
      turn: position.turn,
      // The client renders squares, not FEN -- it has no engine and needs none.
      board: position.board,
      moves: game.moves.map((move) => ({ san: move.san, from: move.from, to: move.to })),
      lastMove: game.lastMove,
      check: isInCheck(position),
      yourColor: color,
      yourTurn,
      createdBy: game.createdBy,
      // Only the side to move is told what it may do.
      legalMoves: yourTurn
        ? legalMoves(position).map((move) => ({ from: move.from, to: move.to, promotion: move.promotion ?? null }))
        : [],
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
    };
  }

  /**
   * The whole game turns on one thing: an opponent's pending throw never
   * leaves the server. The viewer is told *that* they have thrown, never what.
   * Resolved rounds are public -- by then both choices are out.
   */
  function rpsView(viewerId, game) {
    const opponentId = opponentOf(game, viewerId);
    const yourThrow = game.throws[viewerId] ?? null;

    return {
      id: game.id,
      kind: 'rps',
      conversationId: game.conversationId,
      status: game.status,
      result: game.result,
      target: game.target,
      you: playerStub(viewerId),
      opponent: playerStub(opponentId),
      yourScore: game.scores[viewerId] ?? 0,
      opponentScore: game.scores[opponentId] ?? 0,
      yourThrow,
      opponentHasThrown: Boolean(game.throws[opponentId]),
      waitingForYou: game.status === 'active' && !yourThrow,
      rounds: game.rounds.map((round) => ({
        yours: round.throws[viewerId],
        theirs: round.throws[opponentId],
        outcome: round.tie ? 'tie' : round.winner === viewerId ? 'win' : 'loss',
      })),
      createdBy: game.createdBy,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
    };
  }

  const playerStub = (userId) => {
    const player = store.getUser(userId);
    return { id: userId, name: player?.name ?? 'unknown', online: store.isOnline(userId) };
  };

  const colorFor = (game, userId) => (game.white === userId ? 'w' : game.black === userId ? 'b' : null);
  const playersOf = (game) => ((game.kind ?? 'chess') === 'rps' ? game.players : [game.white, game.black]);
  const opponentOf = (game, userId) => playersOf(game).find((id) => id !== userId) ?? userId;

  function mustPlay(gameId, user) {
    const game = store.getGame(gameId);
    if (!game) throw httpError(404, 'Unknown game.');
    if (!playersOf(game).includes(user.id)) throw httpError(403, 'That is not your game.');
    return game;
  }

  function squareIndex(value) {
    const index = Number(value);
    if (!Number.isInteger(index) || index < 0 || index > 63) throw httpError(400, 'Squares are 0–63.');
    return index;
  }

  // ------------------------------------------------------------ read & inbox

  function markRead({ user, body }) {
    requireAuth(user);
    const conversationId = String(body.conversationId ?? '');
    if (!conversationId) throw httpError(400, 'conversationId is required.');
    const seq = store.markRead(user.id, conversationId, body.upToSeq ?? null);

    // Reading a conversation clears the notifications that pointed at it.
    const cleared = store.listNotifications(user.id)
      .filter((n) => n.conversationId === conversationId && !n.read)
      .map((n) => n.id);
    if (cleared.length) store.markNotificationsRead(user.id, cleared);

    const unread = store.unreadFor(user.id, conversationId);
    hub.send(user.id, 'read', { conversationId, seq, unread, clearedNotifications: cleared });
    return { conversationId, seq, unread, clearedNotifications: cleared };
  }

  function getNotifications({ user }) {
    requireAuth(user);
    return { notifications: store.listNotifications(user.id) };
  }

  function readNotifications({ user, body }) {
    requireAuth(user);
    const remaining = store.markNotificationsRead(user.id, body.ids ?? null);
    hub.send(user.id, 'notifications:read', { ids: body.ids ?? null, remaining });
    return { remaining };
  }

  function setDigest({ user, body }) {
    requireAuth(user);
    const digest = store.setDigest(user.id, body);
    // Turning it off must release what it was holding. It cannot go through
    // flushDigests(), which only looks at users who still have it switched on
    // -- by now this user does not, so the held items would be stranded.
    if (!digest.enabled) releaseDigest(user.id);
    scheduler?.armNext();
    hub.send(user.id, 'prefs', { channels: channelViews(user), quietHours: user.prefs.quietHours, digest });
    return { digest, held: store.pendingDigest(user.id).length };
  }

  function setQuietHours({ user, body }) {
    requireAuth(user);
    const quietHours = store.setQuietHours(user.id, body);
    hub.send(user.id, 'prefs', { channels: channelViews(user), quietHours });
    return { quietHours, active: isQuietHoursActive(quietHours) };
  }

  // ------------------------------------------------------------------ events

  function streamEvents({ user, req, res }) {
    requireAuth(user);
    const wasOffline = !store.isOnline(user.id);
    store.setOnline(user.id, +1);
    if (wasOffline) hub.broadcast(allUserIds(), 'presence', { userId: user.id, online: true });

    const unsubscribe = hub.subscribe(user.id, res);
    hub.send(user.id, 'hello', { userId: user.id, serverTime: Date.now() });

    const disconnect = () => {
      unsubscribe();
      const stillOnline = store.setOnline(user.id, -1);
      if (!stillOnline) hub.broadcast(allUserIds(), 'presence', { userId: user.id, online: false });
    };
    req.on('close', disconnect);
    return undefined; // the handler owns the response
  }

  // ------------------------------------------------------------------- views

  function selfView(user) {
    return {
      id: user.id,
      name: user.name,
      prefs: {
        mutedChannels: Object.fromEntries(user.prefs.mutedChannels),
        quietHours: user.prefs.quietHours,
        digest: user.prefs.digest,
      },
      quietHoursActive: isQuietHoursActive(user.prefs.quietHours),
    };
  }

  function channelSummary(channel) {
    return {
      id: channel.id,
      name: channel.name,
      topic: channel.topic,
      memberCount: channel.members.size,
    };
  }

  function channelView(user, channel) {
    const joined = channel.members.has(user.id);
    const counts = joined ? store.unreadFor(user.id, channel.id) : { unread: 0, mentions: 0, lastReadSeq: 0 };
    const last = store.history(channel.id, { limit: 1 })[0] ?? null;
    return {
      ...channelSummary(channel),
      joined,
      muted: isChannelMuted(user, channel.id),
      // null when the mute is indefinite or absent; a timestamp when it lapses.
      mutedUntil: isChannelMuted(user, channel.id) ? mutedUntil(user, channel.id) ?? null : null,
      lastMessage: last,
      ...counts,
    };
  }

  /** Just enough for the sidebar to show whose move it is. */
  function gameSummary(viewerId, game) {
    if (!game) return null;
    const view = gameView(viewerId, game);
    return { id: view.id, status: view.status, yourTurn: view.yourTurn, yourColor: view.yourColor };
  }

  function rpsSummary(viewerId, game) {
    if (!game) return null;
    const view = rpsView(viewerId, game);
    return { id: view.id, status: view.status, waitingForYou: view.waitingForYou };
  }

  const channelViews = (user) => store.listChannels().map((c) => channelView(user, c));
  const allUserIds = () => store.listUsers().map((u) => u.id);

  function requireAuth(user) {
    if (!user) throw httpError(401, 'Pick a username first.');
  }

  return {
    match,
    deliverScheduled,
    flushDigests,
    /** Wired after construction because the scheduler needs deliverScheduled. */
    useScheduler(instance) { scheduler = instance; },
  };
}
