export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...extraHeaders,
    },
  });
}

export function methodNotAllowed(allowed = ['GET']) {
  return json({ error: 'Method not allowed' }, 405, { Allow: allowed.join(', ') });
}
