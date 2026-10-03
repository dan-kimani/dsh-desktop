/**
 * dsh-version.mjs — decide which upstream dsh release the wrapper should build.
 *
 * Shared by `resolve-version.mjs` (the release gate) and `fetch-runtime.mjs` (which
 * has to reach the same answer when run on its own), so the two can never disagree
 * about what "latest" means.
 *
 * Upstream publishes prereleases to several dist-tags at once, and they leapfrog.
 * `alpha` sat behind `next` at 0.1.7, then overtook it at 0.2.1-alpha.1 while
 * `next` and `latest` stayed on 0.2.0-rc.2. Following one tag therefore strands
 * the wrapper on an older build the moment another tag moves ahead, which is why
 * `config/runtime.json` may name `newest` instead of a tag.
 */
import { getJson } from '../fetch-json.mjs';

/** The registry document for one package, whose `dist-tags` map is what we read. */
const registryUrl = (pkg) => `https://registry.npmjs.org/${pkg.replace('/', '%2f')}`;

/** True when a string is valid semver; build metadata is allowed but ignored for order. */
export function isSemver(value) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

/**
 * Split a version into its numeric core and its prerelease identifiers.
 * @param {string} value - a semver string
 * @returns {{core: number[], prerelease: string[]}}
 */
function parse(value) {
  const withoutBuild = value.split('+', 1)[0];
  const dash = withoutBuild.indexOf('-');
  return {
    core: (dash === -1 ? withoutBuild : withoutBuild.slice(0, dash)).split('.').map(Number),
    prerelease: dash === -1 ? [] : withoutBuild.slice(dash + 1).split('.'),
  };
}

/**
 * Compare two semver strings by precedence (SemVer §11).
 *
 * Build metadata is ignored, exactly as the spec requires and as the wrapper relies
 * on elsewhere: it never encodes a build counter, because two versions differing
 * only by `+...` compare equal and a release would be skipped as already built.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when `a` precedes `b`, positive when it follows, 0 when equal
 */
export function compareSemver(a, b) {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
  }

  // A release outranks its own prereleases; otherwise compare identifiers in order.
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i += 1) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) {
      if (Number(l) !== Number(r)) return Number(l) - Number(r);
    } else if (lNumeric !== rNumeric) {
      return lNumeric ? -1 : 1; // numeric identifiers precede alphanumeric ones
    } else if (l !== r) {
      return l < r ? -1 : 1; // ASCII lexical order
    }
  }
  return 0;
}

/**
 * The highest-precedence version across a dist-tags map.
 *
 * Tags that do not name a semver version are skipped rather than treated as an
 * error: a stray `dev`/`canary` tag must not be able to break a release run.
 *
 * @param {Record<string, string>} tags - the registry's `dist-tags`
 * @returns {{tag: string, version: string}}
 */
export function pickNewest(tags) {
  const candidates = Object.entries(tags).filter(([, version]) => isSemver(version));
  if (candidates.length === 0) {
    throw new Error(
      `no npm dist-tag names a semver version; available: ${Object.keys(tags).join(', ') || '(none)'}`,
    );
  }
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (compareSemver(candidate[1], best[1]) > 0) best = candidate;
  }
  return { tag: best[0], version: best[1] };
}

/**
 * Resolve the version to build for the configured npm tag.
 *
 * A concrete tag (`alpha`, `next`, `latest`) is an explicit channel pin; the
 * literal `newest` picks the highest published version across every tag.
 *
 * @param {string} pkg - npm package name, e.g. `@deepseek-ai/dsh`
 * @param {string} tag - configured tag, or `newest`
 * @returns {Promise<{version: string, tag: string, tags: Record<string, string>}>}
 *   the resolved version, the tag it came from, and every tag for logging
 */
export async function resolveDshVersion(pkg, tag) {
  const tags = (await getJson(registryUrl(pkg), { registry: true }))['dist-tags'] ?? {};
  if (tag === 'newest') {
    return { ...pickNewest(tags), tags };
  }
  const version = tags[tag];
  if (version === undefined) {
    throw new Error(
      `npm has no dist-tag ${JSON.stringify(tag)} for ${pkg}; available: ${Object.keys(tags).join(', ')}`,
    );
  }
  return { version, tag, tags };
}
