// Google OAuth 2.0 for installed apps: loopback redirect + PKCE + state.
// Only the refresh token (and metadata) is persisted, in a 0600 file (on Windows the
// data folder is locked down with icacls by install.ps1).
//
// The sign-in page is opened in the default browser automatically; the URL is printed as well.
// Remote fallback for machines without a usable browser: the technician opens the URL on
// their own laptop, and pastes the final http://127.0.0.1:... address (or just the code)
// into the console. A pasted URL must carry the right state; the code is always redeemed
// with our PKCE verifier and loopback redirect_uri, so a code from another flow is useless.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
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

/**
 * The command that opens `url` in the default browser, without a shell (the URL contains "&").
 * Windows: explorer.exe hands the URL to the running desktop shell, so the browser starts with
 * the technician's normal rights even when this program runs elevated (install.ps1 must).
 * rundll32 would start it from this process, with the Administrator token. Explorer splits its
 * command line at commas; the sign-in URL has none (query values are percent-encoded).
 */
export function browserCommand(url, platform = process.platform) {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Best effort: open `url` in the default browser. Returns false if the launcher could not be
 * started synchronously; a later failure (e.g. no xdg-open) is ignored, the URL is printed anyway.
 */
export function openBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  const { cmd, args } = browserCommand(url, platform);
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

function stateMatches(got, expected) {
  const a = Buffer.from(got || '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Turn what the technician pasted into an authorization code.
 * Accepts the full redirect address (state is checked) or the bare code.
 */
export function parsePastedRedirect(text, expectedState) {
  const t = String(text ?? '').trim().replace(/^["']|["']$/g, '');
  if (!t) throw new AuthError('nothing was pasted');
  if (/^https?:\/\//i.test(t) || t.includes('?') || t.includes('&')) {
    let url;
    try {
      url = new URL(t.includes('://') ? t : `http://127.0.0.1/${t.startsWith('?') ? t : `?${t}`}`);
    } catch {
      throw new AuthError('the pasted address is not a valid URL');
    }
    const p = url.searchParams;
    if (p.get('error')) throw new AuthError(`authorization denied: ${p.get('error')}`);
    if (!stateMatches(p.get('state'), expectedState)) {
      throw new AuthError('OAuth state mismatch; login aborted (paste the address from THIS login attempt)');
    }
    const code = p.get('code');
    if (!code) throw new AuthError('the pasted address contains no code');
    return code;
  }
  if (!/^[\w\-./~%]+$/.test(t)) throw new AuthError('the pasted text is neither a URL nor an authorization code');
  return decodeURIComponent(t);
}

/**
 * Read pasted lines from `input` until one parses. Returns { code, close }.
 * Invalid pastes are reported through onInvalid and the user may try again,
 * except a state mismatch, which aborts.
 */
export function waitForPastedCode({ input, expectedState, onInvalid = () => {} }) {
  const rl = readline.createInterface({ input, terminal: false });
  let done = false;
  const code = new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      if (done || !line.trim()) return;
      try {
        const c = parsePastedRedirect(line, expectedState);
        done = true;
        rl.close();
        resolve(c);
      } catch (err) {
        if (/state mismatch|denied/.test(err.message)) {
          done = true;
          rl.close();
          reject(err);
        } else onInvalid(err);
      }
    });
    // If input ends (e.g. not a console) we simply stop listening: the loopback flow may still finish.
    rl.on('close', () => {
      done = true;
    });
  });
  return {
    code,
    close: () => {
      done = true;
      rl.close();
    },
  };
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
      const stateOk = stateMatches(url.searchParams.get('state'), expectedState);
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
      const close = () => {
        clearTimeout(timer);
        server.close();
        server.closeAllConnections?.();
      };
      resolveServer({ redirectUri: `http://127.0.0.1:${port}`, code: codePromise, close });
    });
  });
}

/**
 * Interactive login. `prompt(url, { browserOpened })` shows the consent URL to the user;
 * `openBrowser(url)` (optional) opens it first and returns whether that was attempted.
 * With `input` (a readable stream, normally stdin) the user may also paste the redirect
 * address or code; whichever arrives first (loopback or paste) wins.
 * Returns the connected email address.
 */
export async function login(google, { prompt, openBrowser: open, loginHint, input, onInvalidPaste, timeoutMs } = {}) {
  const state = crypto.randomBytes(24).toString('base64url');
  const loopback = await startLoopbackServer({ expectedState: state, timeoutMs });
  const { redirectUri } = loopback;
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
  const browserOpened = open ? Boolean(open(url)) : false;
  prompt(url, { browserOpened });
  const paste = input ? waitForPastedCode({ input, expectedState: state, onInvalid: onInvalidPaste }) : null;
  let code;
  try {
    code = await (paste ? Promise.race([loopback.code, paste.code]) : loopback.code);
  } finally {
    loopback.close();
    paste?.close();
    loopback.code.catch(() => {});
    paste?.code.catch(() => {});
  }
  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
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
