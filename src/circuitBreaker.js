'use strict';

// Circuit breaker around PromptPilot's model provider.
//
// The supplied tests in test/circuitBreaker.test.js describe the exact behaviour.
//
//   - Start in the CLOSED state. While CLOSED, count calls and failures.
//   - OPEN when (failures / calls) >= failureThreshold AND calls >= minimumRequests.
//   - While OPEN and within openMillis, SHORT-CIRCUIT: throw CircuitOpenError
//     WITHOUT calling fn, and increment metrics.short_circuited_total.
//   - After openMillis has elapsed (using the injected now()), allow ONE probe
//     call (HALF_OPEN). A successful probe -> CLOSED and reset the counts.
//     A failed probe -> OPEN again.
//   - Increment metrics.breaker_open_total every time it moves to OPEN.
//   - Call options.onStateChange(state) on every state transition, and emit
//     one structured log event per transition (safe metadata only).
//
// Injected options (all optional, with sensible defaults):
//   failureThreshold, minimumRequests, openMillis, now, onStateChange, name, log

const DEFAULTS = {
  failureThreshold: 0.5,
  minimumRequests: 5,
  openMillis: 30_000,
};

class CircuitOpenError extends Error {
  constructor() {
    super('circuit is open');
    this.code = 'CIRCUIT_OPEN';
  }
}

// Default sink: one JSON line on stderr. It carries counts, rates and state
// names only — never the ticket, the prompt, the provider response or a key.
function defaultLog(event) {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

function createCircuitBreaker(options = {}) {
  const failureThreshold = options.failureThreshold ?? DEFAULTS.failureThreshold;
  const minimumRequests = options.minimumRequests ?? DEFAULTS.minimumRequests;
  const openMillis = options.openMillis ?? DEFAULTS.openMillis;
  const now = options.now ?? Date.now;
  const onStateChange = options.onStateChange ?? function () {};
  const name = options.name ?? 'model_provider';
  const log = options.log ?? defaultLog;

  const metrics = {
    breaker_open_total: 0,
    short_circuited_total: 0,
    success_total: 0,
    failure_total: 0,
  };

  let state = 'CLOSED';
  let calls = 0;
  let failures = 0;
  let openedAt = 0;
  let probeInFlight = false;

  function transition(next, reason) {
    const from = state;
    state = next;
    if (next === 'OPEN') {
      metrics.breaker_open_total += 1;
      openedAt = now();
    }
    log({
      event: 'circuit_state_change',
      breaker: name,
      from,
      to: next,
      reason,
      calls,
      failures,
      failure_rate: calls === 0 ? 0 : Number((failures / calls).toFixed(3)),
      breaker_open_total: metrics.breaker_open_total,
      short_circuited_total: metrics.short_circuited_total,
      at: now(),
    });
    onStateChange(next);
  }

  function resetCounts() {
    calls = 0;
    failures = 0;
  }

  function shouldTrip() {
    return calls >= minimumRequests && failures / calls >= failureThreshold;
  }

  function shortCircuit() {
    metrics.short_circuited_total += 1;
    throw new CircuitOpenError();
  }

  async function exec(fn) {
    if (state === 'OPEN') {
      if (now() - openedAt < openMillis) shortCircuit();
      transition('HALF_OPEN', 'open_window_elapsed');
    }

    // Only one probe may test a recovering provider; everyone else keeps
    // getting the fast fallback until that probe settles.
    if (state === 'HALF_OPEN') {
      if (probeInFlight) shortCircuit();
      probeInFlight = true;
      try {
        const result = await fn();
        metrics.success_total += 1;
        resetCounts();
        transition('CLOSED', 'probe_succeeded');
        return result;
      } catch (err) {
        metrics.failure_total += 1;
        transition('OPEN', 'probe_failed');
        throw err;
      } finally {
        probeInFlight = false;
      }
    }

    calls += 1;
    try {
      const result = await fn();
      metrics.success_total += 1;
      return result;
    } catch (err) {
      failures += 1;
      metrics.failure_total += 1;
      // A call that started while CLOSED can settle after another call has
      // already tripped the breaker; only trip from CLOSED.
      if (state === 'CLOSED' && shouldTrip()) transition('OPEN', 'failure_threshold_crossed');
      throw err;
    }
  }

  return {
    exec,
    metrics,
    get state() {
      return state;
    },
  };
}

module.exports = { createCircuitBreaker, CircuitOpenError };
