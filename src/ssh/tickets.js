const encoder = new TextEncoder();
const ISSUER = 'citadel-hub';
const AUDIENCE = 'citadel-ssh-gateway';
export const SSH_TICKET_SECONDS = 60;
export const SSH_SESSION_SECONDS = 1800;

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error('invalid_ssh_ticket');
  const base = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base + '='.repeat((4 - base.length % 4) % 4)), c => c.charCodeAt(0));
}
async function key(secret) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512 || /\s/.test(secret)) {
    throw Error('ssh_gateway_secret_invalid');
  }
  return crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign', 'verify']);
}
export async function issueSshTicket(secret, {node_id, actor_id}, now = Math.floor(Date.now() / 1000)) {
  const claims = {v: 1, iss: ISSUER, aud: AUDIENCE, jti: crypto.randomUUID(), node_id, actor_id,
    iat: now, exp: now + SSH_TICKET_SECONDS, session_exp: now + SSH_SESSION_SECONDS};
  const payload = encode(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload));
  return {ticket: payload + '.' + encode(new Uint8Array(signature)), claims};
}
export async function verifySshTicket(secret, ticket, now = Math.floor(Date.now() / 1000)) {
  if (typeof ticket !== 'string' || ticket.length > 2048) throw Error('invalid_ssh_ticket');
  const parts = ticket.split('.');
  if (parts.length !== 2) throw Error('invalid_ssh_ticket');
  const valid = await crypto.subtle.verify('HMAC', await key(secret), decode(parts[1]), encoder.encode(parts[0]));
  if (!valid) throw Error('invalid_ssh_ticket');
  let claims;
  try { claims = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(decode(parts[0]))); }
  catch { throw Error('invalid_ssh_ticket'); }
  if (claims?.v !== 1 || claims.iss !== ISSUER || claims.aud !== AUDIENCE ||
      !/^[a-f0-9-]{36}$/i.test(claims.jti || '') ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(claims.node_id || '') ||
      typeof claims.actor_id !== 'string' || !claims.actor_id || claims.actor_id.length > 128 ||
      ![claims.iat, claims.exp, claims.session_exp].every(Number.isInteger) ||
      claims.iat > now + 5 || claims.exp <= now || claims.exp <= claims.iat ||
      claims.exp - claims.iat > SSH_TICKET_SECONDS ||
      claims.session_exp <= claims.exp || claims.session_exp - claims.iat > SSH_SESSION_SECONDS) {
    throw Error('invalid_ssh_ticket');
  }
  return claims;
}
