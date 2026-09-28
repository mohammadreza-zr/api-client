/** Assertion helpers shared by the newer suites. Not part of the package. */

export function createChecker() {
  let pass = 0,
    fail = 0;
  return {
    check(name, cond, detail = "") {
      if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
      } else {
        fail++;
        console.log(`  ✗ ${name} ${detail}`);
      }
    },
    /** Prints the tally and exits non-zero on any failure. */
    finish() {
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    },
  };
}

/** Resolves with the promise's value, or "TIMED OUT" after `ms` — so a hang fails instead of stalling. */
export const within = (promise, ms) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("TIMED OUT"), ms))]);

/** The rejection reason, or `undefined` if the promise resolved. */
export const rejection = (promise) => promise.then(() => undefined, (error) => error);
