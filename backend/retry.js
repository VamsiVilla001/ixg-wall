// Tries something that may fail for a while (a cloud service, a rate limit, the network),
// waiting longer each time, and gives up only on an error that waiting won't fix or after
// the last wait. Resolves { ok, tries, error? }; never throws.
const WAITS_MS = [10000, 30000, 90000, 5 * 60000, 10 * 60000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fn(): resolves when done, throws an Error (with `code`, and `retryAfterMs` when the service
// said how long to wait) otherwise. final(err): true when there's no point trying again.
// onRetry({ tries, waitMs, error }): what's about to happen, for a log.
async function retrying(fn, { waits = WAITS_MS, final = () => false, onRetry = () => {} } = {}) {
  let tries = 0;
  for (;;) {
    tries += 1;
    try {
      await fn();
      return { ok: true, tries };
    } catch (err) {
      const wait = err?.retryAfterMs ?? waits[tries - 1];
      if (final(err)) return { ok: false, tries, error: String(err?.message || err) };
      if (wait == null) return { ok: false, tries, error: `${err?.message || err}; gave up after ${tries} tries` };
      onRetry({ tries, waitMs: wait, error: String(err?.message || err) });
      await sleep(wait);
    }
  }
}

// One-at-a-time queue: each job waits for the one before, so a destination is never asked
// for two uploads at once. `run` resolves what the job resolves.
class Queue {
  constructor() {
    this.tail = Promise.resolve();
    this.pending = 0;
  }

  run(job) {
    this.pending += 1;
    const p = this.tail.then(job).finally(() => { this.pending -= 1; });
    this.tail = p.catch(() => {});
    return p;
  }
}

module.exports = { retrying, Queue, WAITS_MS };
