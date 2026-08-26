/**
 * HTTP API.
 *
 * Sessions are bearer tokens sent in the Authorization header (not cookies),
 * so you can be logged in as a different user in every browser tab -- which is
 * what makes this app testable by one person.
 */

import crypto from 'node:crypto';

import { httpError, publicMessage, publicUser } from './store.js';
import { isChannelMuted, isQuietHoursActive, routeMessage } from './notifications.js';
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
    ['POST', /^\/api\/games\/([\w]+)\/resign$/, resignGame],

    ['POST', /^\/api\/read$/, markRead],
    ['GET', /^\/api\/notifications$/, getNotifications],
    ['POST', /^\/api\/notifications\/read$/, readNotifications],
    ['PATCH', /^\/api\/settings\/quiet-hours$/, setQuietHours],
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
        game: gameSummary(user.id, store.activeGameIn(thread.conversationId)),
      })),
      notifications: store.listNotifications(user.id),
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
    if ('muted' in body) store.setChannelMute(user.id, channelId, Boolean(body.muted));
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
    const message = store.postDirectMessage({ fromId: user.id, toId: other.id, text: body.text });
    deliver({ message, channel: null, recipients: [user.id, other.id] });
    return { message: publicMessage(message) };
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

      hub.send(recipientId, 'notification', { notification });
    }
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
    if (store.activeGameIn(conversationId)) {
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

    for (const playerId of [game.white, game.black]) {
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
      preview: `♟ ${title} — ${preview}`,
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
    for (const playerId of [game.white, game.black]) {
      hub.send(playerId, 'game', { game: gameView(playerId, game) });
    }
  }

  function gameView(viewerId, game) {
    const position = parseFen(game.fen);
    const color = colorFor(game, viewerId);
    const yourTurn = game.status === 'active' && color === position.turn;

    return {
      id: game.id,
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

  const playerStub = (userId) => {
    const player = store.getUser(userId);
    return { id: userId, name: player?.name ?? 'unknown', online: store.isOnline(userId) };
  };

  const colorFor = (game, userId) => (game.white === userId ? 'w' : game.black === userId ? 'b' : null);
  const opponentOf = (game, userId) => (game.white === userId ? game.black : game.white);

  function mustPlay(gameId, user) {
    const game = store.getGame(gameId);
    if (!game) throw httpError(404, 'Unknown game.');
    if (game.white !== user.id && game.black !== user.id) throw httpError(403, 'That is not your game.');
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
        mutedChannels: [...user.prefs.mutedChannels],
        quietHours: user.prefs.quietHours,
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

  const channelViews = (user) => store.listChannels().map((c) => channelView(user, c));
  const allUserIds = () => store.listUsers().map((u) => u.id);

  function requireAuth(user) {
    if (!user) throw httpError(401, 'Pick a username first.');
  }

  return { match };
}
