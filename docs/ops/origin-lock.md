# Origin lock on the Everlyce box

The API listens on `127.0.0.1` only (`server/src/index.js`). It is not reachable
from another machine. nginx (or another reverse proxy on the same box) is the
process that should hold the public ports.

That is enough when the box's firewall also refuses inbound connections except
to nginx. It is not enough once the name sits behind Cloudflare and the origin
address is still open to the whole internet: anyone who learns the address can
skip Cloudflare and talk to nginx directly.

## What to lock

- Bind the Node process to `127.0.0.1`. Do not change that to `0.0.0.0`.
- Publish only 443 (and 80 for the certificate challenge, if you use one) and
  only on nginx.
- If the hostname is orange-clouded, allow nginx to accept proxied traffic from
  Cloudflare's published IP ranges and refuse the rest at the host firewall.
  Cloudflare documents those ranges; they change, so the firewall rule has to
  be updated when they do.
- Prefer Authenticated Origin Pulls, or a Cloudflare Tunnel, when you do not
  want the origin address to answer public TLS at all. A tunnel removes the
  need to leave 443 open to the internet.
- Keep `POS_ALLOWED_HOSTS` set to the names you actually serve. A request whose
  `Host` is not on that list is refused with `421`, which stops a client who
  reached the box by raw IP from being treated as the shop.

The application will not see the real client address unless nginx sends
`X-Forwarded-For` and `X-Real-IP`, as in the nginx example in the README. Do
not put Node on a public interface to "make the IP visible".
