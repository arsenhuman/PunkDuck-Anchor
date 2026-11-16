// Google OAuth 2.0 for installed apps: loopback redirect + PKCE + state.
// Only the refresh token (and metadata) is persisted, in a 0600 file.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';

export const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function readToken(tokenFile) {
  try {
    return JSON.parse(await fs.readFile(tokenFile, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new AuthError(`cannot read token file ${tokenFile}: ${err.message}`);
  }
}

export async function writeToken(tokenFile, data) {
  await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  const tmp = `${tokenFile}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, tokenFile);
  await fs.chmod(tokenFile, 0o600);
}

function newClient(google, redirectUri) {
  return new OAuth2Client({ clientId: google.clientId, clientSecret: google.clientSecret, redirectUri });
}

/** Returns an OAuth2Client with credentials loaded, or throws if not logged in. */
export async function getAuthorizedClient(google) {
  const stored = await readToken(google.tokenFile);
  if (!stored?.refresh_token) {
    throw new AuthError('not logged in to Google: run `backup-manager auth login` first');
  }
  const client = newClient(google);
  client.setCredentials({ refresh_token: stored.refresh_token });
  client.on('tokens', (t) => {
    // Google may rotate the refresh token; persist it if so.
    if (t.refresh_token && t.refresh_token !== stored.refresh_token) {
      stored.refresh_token = t.refresh_token;
      writeToken(google.tokenFile, stored).catch(() => {});
    }
  });
  return client;
}

export async function fetchAccountEmail(request) {
  const res = await request({
    url: 'https://www.googleapis.com/drive/v3/about',
    method: 'GET',
    params: { fields: 'user(emailAddress)' },
  });
  return res.data?.user?.emailAddress;
}

/** Wait for Google's redirect on a random loopback port; resolves with the auth code. */
export function startLoopbackServer({ expectedState, timeoutMs = LOGIN_TIMEOUT_MS }) {
  return new Promise((resolveServer, rejectServer) => {
    let settle;
    const codePromise = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const finish = (status, text, outcome) => {
        res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
        clearTimeout(timer);
        server.close();
        outcome();
      };
      const got = Buffer.from(url.searchParams.get('state') || '');
      const want = Buffer.from(expectedState);
      const stateOk = got.length === want.length && crypto.timingSafeEqual(got, want);
      if (!stateOk) {
        return finish(400, 'Invalid state. You can close this window.', () =>
          settle.reject(new AuthError('OAuth state mismatch; login aborted')));
      }
      const error = url.searchParams.get('error');
      if (error) {
        return finish(400, `Authorization failed: ${error}. You can close this window.`, () =>
          settle.reject(new AuthError(`authorization denied: ${error}`)));
      }
      const code = url.searchParams.get('code');
      if (!code) {
        return finish(400, 'Missing code. You can close this window.', () =>
          settle.reject(new AuthError('no authorization code received')));
      }
      finish(200, 'backup-manager is now connected to Google Drive. You can close this window.', () =>
        settle.resolve(code));
    });
    const timer = setTimeout(() => {
      server.close();
      settle.reject(new AuthError('timed out waiting for Google authorization'));
    }, timeoutMs);
    timer.unref?.();
    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({ redirectUri: `http://127.0.0.1:${port}`, code: codePromise });
    });
  });
}

/**
 * Interactive login. `prompt(url)` shows the consent URL to the user.
 * Returns the connected email address.
 */
export async function login(google, { prompt, loginHint } = {}) {
  const state = crypto.randomBytes(24).toString('base64url');
  const { redirectUri, code } = await startLoopbackServer({ expectedState: state });
  const client = newClient(google, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // guarantees a refresh token
    scope: SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
    login_hint: loginHint,
  });
  prompt(url);
  const { tokens } = await client.getToken({ code: await code, codeVerifier, redirect_uri: redirectUri });
  if (!tokens.refresh_token) throw new AuthError('Google did not return a refresh token');
  client.setCredentials(tokens);
  const email = await fetchAccountEmail((o) => client.request(o));
  await writeToken(google.tokenFile, {
    refresh_token: tokens.refresh_token,
    scope: tokens.scope,
    email,
    createdAt: new Date().toISOString(),
  });
  return email;
}

export async function status(google) {
  const stored = await readToken(google.tokenFile);
  if (!stored?.refresh_token) return { loggedIn: false };
  const client = await getAuthorizedClient(google);
  const email = await fetchAccountEmail((o) => client.request(o));
  return { loggedIn: true, email, tokenFile: google.tokenFile };
}

export async function logout(google) {
  let stored;
  try {
    stored = await readToken(google.tokenFile);
  } catch {
    // Corrupt/unreadable token file: nothing to revoke, but still remove it.
    await fs.rm(google.tokenFile, { force: true });
    return { removed: true, revoked: false };
  }
  if (!stored) return { removed: false };
  let revoked = false;
  if (stored.refresh_token) {
    try {
      await newClient(google).revokeToken(stored.refresh_token);
      revoked = true;
    } catch {
      // token may already be invalid; still remove it locally
    }
  }
  await fs.rm(google.tokenFile, { force: true });
  return { removed: true, revoked };
}
