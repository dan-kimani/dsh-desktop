/**
 * fetch-json.mjs — small networking helper shared by the build scripts.
 *
 * Why not `fetch`: this wrapper's scripts run in environments (sandboxes, some CI
 * runners, restricted containers) that resolve AAAA records but have no working
 * IPv6 route. Node's `fetch` has no way to constrain the address family, so it can
 * fail with `ENETUNREACH` on an IPv6 address while IPv4 works fine — a failure
 * that looks like "the registry is down" but is really "IPv6 is unreachable". The
 * `https` module accepts `family`, so requests here try IPv4 first and fall back to
 * the system default, which keeps IPv4-only, IPv6-only and dual-stack hosts working.
 *
 * Also adds a bounded timeout, because a hung socket in CI is worse than an error.
 */
import { get } from 'node:https';

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Perform one HTTPS GET attempt, optionally forcing an address family.
 * @param {string} url - absolute https URL
 * @param {{headers: Record<string,string>, family: 0|4|6, timeoutMs: number}} options
 * @returns {Promise<{status:number, body:Buffer}>}
 */
function attempt(url, options) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers: options.headers, family: options.family }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }),
      );
    });
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new Error(`request to ${url} timed out after ${options.timeoutMs}ms`));
    });
    request.on('error', reject);
  });
}

/**
 * GET an HTTPS URL, preferring IPv4 and falling back to the system default.
 *
 * Unlike `fetch`, a non-2xx status is returned rather than thrown, so callers can
 * distinguish "404 with a JSON error body" from a transport failure.
 *
 * @param {string} url - absolute https URL
 * @param {object} [options]
 * @param {Record<string,string>} [options.headers] - extra request headers
 * @param {boolean} [options.registry] - add the npm registry accept header
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{status:number, body:Buffer}>}
 * @throws {Error} only when both attempts fail at the transport layer
 */
export async function getRaw(url, options = {}) {
  const headers = {
    'user-agent': 'dsh-desktop-build',
    ...(options.registry ? { accept: 'application/vnd.npm.install-v1+json' } : {}),
    ...(options.headers ?? {}),
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let firstError;
  for (const family of [4, 0]) {
    try {
      return await attempt(url, { headers, family, timeoutMs });
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }
  const first = firstError instanceof Error ? firstError.message : String(firstError);
  const second = 'both IPv4 and default address attempts failed';
  throw new Error(`${url} is unreachable (${first}; ${second})`);
}

/**
 * GET an HTTPS URL and decode the body as UTF-8, asserting a 2xx status.
 * @param {string} url - absolute https URL
 * @param {object} [options] - see {@link getRaw}
 * @returns {Promise<string>} response body
 */
export async function getText(url, options = {}) {
  const response = await getRaw(url, options);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.body.toString('utf8');
}

/**
 * GET an HTTPS URL and decode the body as UTF-8 without asserting the status.
 * @param {string} url - absolute https URL
 * @param {object} [options] - see {@link getRaw}
 * @returns {Promise<{status:number, text:string}>}
 */
export async function getTextWithStatus(url, options = {}) {
  const response = await getRaw(url, options);
  return { status: response.status, text: response.body.toString('utf8') };
}

/**
 * GET an HTTPS URL and parse the body as JSON, asserting a 2xx status.
 * @param {string} url - absolute https URL
 * @param {object} [options] - see {@link getRaw}
 * @returns {Promise<any>} parsed JSON
 */
export async function getJson(url, options = {}) {
  return JSON.parse(await getText(url, options));
}
