/**
 * Server-sent-events hub: one stream per open tab, addressed by user id.
 * Used to push new messages, unread updates and notifications in real time.
 */
export function createHub() {
  const clients = new Map(); // userId -> Set<res>

  function subscribe(userId, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(res);

    // Proxies and browsers drop idle streams; a comment every 25s keeps it warm.
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
    keepAlive.unref?.();

    const cleanup = () => {
      clearInterval(keepAlive);
      const set = clients.get(userId);
      if (!set) return;
      set.delete(res);
      if (set.size === 0) clients.delete(userId);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return cleanup;
  }

  function send(userId, type, data) {
    const set = clients.get(userId);
    if (!set) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
      } catch {
        set.delete(res);
      }
    }
  }

  function broadcast(userIds, type, data) {
    for (const userId of userIds) send(userId, type, data);
  }

  const connectedUsers = () => [...clients.keys()];

  return { subscribe, send, broadcast, connectedUsers };
}
