#!/usr/bin/env node
/**
 * test-version-resolve.mjs — pin the "which upstream release is newest" rule.
 *
 * The wrapper follows `npm.tag: "newest"`, which is only correct if semver
 * precedence is implemented properly: upstream's dist-tags leapfrog each other
 * (`next`/`latest` held 0.2.0-rc.2 while `alpha` moved to 0.2.1-alpha.1), and a
 * wrong comparison silently builds an older release instead of failing. Nothing
 * else exercises that code without a live registry fetch, so the cases are fixed
 * here.
 *
 * Usage: node scripts/test-version-resolve.mjs
 */
import { compareSemver, isSemver, pickNewest } from './lib/dsh-version.mjs';

let failed = 0;

/**
 * Record one assertion.
 * @param {string} label - what is being checked
 * @param {boolean} condition - the assertion
 * @param {string} [detail] - context on failure
 */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

console.log('1. semver precedence');
// The leapfrog that motivated `newest`: a patch bump outranks the older base even
// though its prerelease identifier (`alpha`) sorts below `rc`.
check('0.2.1-alpha.1 outranks 0.2.0-rc.2', compareSemver('0.2.1-alpha.1', '0.2.0-rc.2') > 0);
check('0.2.0-rc.2 precedes 0.2.1-alpha.1', compareSemver('0.2.0-rc.2', '0.2.1-alpha.1') < 0);
// A release outranks its own prereleases, which is what keeps a stable build from
// looking older than the RC it followed.
check('0.2.0 outranks 0.2.0-rc.2', compareSemver('0.2.0', '0.2.0-rc.2') > 0);
check('0.2.0-rc.2 precedes 0.2.0', compareSemver('0.2.0-rc.2', '0.2.0') < 0);
// Numeric identifiers compare numerically, not as strings.
check('rc.10 outranks rc.2', compareSemver('0.2.0-rc.10', '0.2.0-rc.2') > 0);
// Numeric identifiers precede alphanumeric ones.
check('alpha.1 precedes alpha.beta', compareSemver('0.2.0-alpha.1', '0.2.0-alpha.beta') < 0);
// A shorter prerelease list is lower when its prefix matches.
check('alpha precedes alpha.1', compareSemver('0.2.0-alpha', '0.2.0-alpha.1') < 0);
// Build metadata is ignored for ordering.
check('build metadata is ignored', compareSemver('0.2.0+build.9', '0.2.0') === 0);
check('equal versions compare equal', compareSemver('0.2.0-rc.2', '0.2.0-rc.2') === 0);

console.log('\n2. semver recognition');
check('accepts a prerelease', isSemver('0.2.1-alpha.1'));
check('accepts a release', isSemver('0.2.0'));
check('rejects a bare tag name', !isSemver('latest'));
check('rejects a partial version', !isSemver('0.2'));

console.log('\n3. newest across dist-tags');
const leapfrogged = pickNewest({ alpha: '0.2.1-alpha.1', next: '0.2.0-rc.2', latest: '0.2.0-rc.2' });
check(
  'picks the alpha channel when it leads',
  leapfrogged.version === '0.2.1-alpha.1' && leapfrogged.tag === 'alpha',
  JSON.stringify(leapfrogged),
);
// The reverse case, so `newest` is not merely "prefer alpha".
const stable = pickNewest({ alpha: '0.2.0-alpha.1', next: '0.2.0', latest: '0.2.0' });
check(
  'prefers the release over an older-base prerelease',
  stable.version === '0.2.0',
  JSON.stringify(stable),
);
const everyTag = pickNewest({ alpha: '0.2.1-alpha.1', next: '0.2.0-rc.2', latest: '0.2.0-rc.2' });
check('does not depend on tag iteration order', everyTag.version === '0.2.1-alpha.1');
// A stray non-semver tag must not break a release run.
const stray = pickNewest({ dev: 'not-a-version', latest: '1.0.0' });
check('skips non-semver tags', stray.version === '1.0.0' && stray.tag === 'latest', JSON.stringify(stray));

console.log(failed === 0 ? '\nVERSION RESOLVE TEST PASSED' : `\nVERSION RESOLVE TEST FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
