export default {
  async fetch(request, env) {
    const configuredBackend = String(env.DOWNLOADER_BACKEND_URL || '').trim();
    if (!configuredBackend) {
      return Response.json(
        { error: 'DOWNLOADER_BACKEND_URL is not configured.' },
        { status: 503 },
      );
    }

    let backend;
    try {
      backend = new URL(configuredBackend);
    } catch {
      return Response.json(
        { error: 'DOWNLOADER_BACKEND_URL must be a valid HTTP or HTTPS URL.' },
        { status: 500 },
      );
    }

    if (!['http:', 'https:'].includes(backend.protocol)) {
      return Response.json(
        { error: 'DOWNLOADER_BACKEND_URL must use HTTP or HTTPS.' },
        { status: 500 },
      );
    }

    const incoming = new URL(request.url);
    const upstream = new URL(`${incoming.pathname}${incoming.search}`, backend.origin);
    const headers = new Headers(request.headers);
    headers.delete('host');

    return fetch(new Request(upstream, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    }));
  },
};