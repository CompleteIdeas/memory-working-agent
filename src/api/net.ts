import type { IncomingMessage } from 'node:http';

/** True when the request reached us over HTTPS (directly or via a proxy such as `tailscale serve`), or from the
 *  same machine. Install, offline storage and push need a secure context; a phone on http://100.x… does not get one. */
export function secureContext(req: IncomingMessage): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  if (proto === 'https' || (req.socket as { encrypted?: boolean }).encrypted) return true;
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
