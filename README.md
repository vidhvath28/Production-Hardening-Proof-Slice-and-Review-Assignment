# Starter — Circuit Breaker Proof Slice (PromptPilot)

This is the starter repository for **Option B (provided scenario)** of the assignment.

Repository: `https://github.com/kalviumcommunity/Production-Hardening-Proof-Slice-and-Review-Assignment` (public, owned by
`kalviumcommunity`). Fork it, implement the breaker, and open a pull request back to your fork.

> The control here is a **circuit breaker**, covered earlier in this module. You are applying a
> concept you have already learned, not a new one.

## Scenario

PromptPilot drafts support replies by calling an external model provider. When the provider is slow
or failing, every request still tries it, so doomed calls pile up and the failure spreads. You will
add a **circuit breaker** so sustained failures short-circuit fast to a safe fallback, then recover
through a probe.

## Your task

Implement the circuit breaker in [`src/circuitBreaker.js`](./src/circuitBreaker.js). The file has a
skeleton and a `TODO`. The behaviour is fully specified by the supplied tests.

Prerequisite: Node.js 18 or newer (the tests use Node's built-in test runner). Then run:

```bash
node --test
```

Make **all tests pass**. Do **not** modify the tests. The reply path in `src/replyService.js` is
already wired to your breaker.

The breaker must:

- start `CLOSED` and count calls and failures;
- move to `OPEN` when `failures / calls >= failureThreshold` **and** `calls >= minimumRequests`;
- while `OPEN` and within `openMillis`, short-circuit (throw `CircuitOpenError` without calling the
  dependency) and increment `metrics.short_circuited_total`;
- after `openMillis` elapses (using the injected `now()`), allow one `HALF_OPEN` probe — success
  closes it and resets counts, failure re-opens it;
- increment `metrics.breaker_open_total` on every trip and call `onStateChange(state)` on every
  transition.

## What to submit

Open a pull request on a branch named `production-hardening-slice`, and in your README include these
labelled sections:

1. **Risk addressed**
2. **Chosen control**
3. **How to run / test**
4. **Evidence** (a reviewer can confirm it works without reading all your code)
5. **Observability note** (which metric moves and which state changes are logged)
6. **Trade-off**
7. **Remaining risk**
8. **How this production control protects my Modules 1–3 design**

Submit the pull-request URL.

---

# Submission — Circuit Breaker Proof Slice (Option B)

## 1. Risk addressed

When the model provider is down or slow, every `draftReply` still calls it. Doomed calls pile up, tie
up the service and push load onto a provider that is trying to recover, so one failing dependency
spreads into a PromptPilot outage.

## 2. Chosen control

A circuit breaker in [`src/circuitBreaker.js`](./src/circuitBreaker.js), wrapped around the provider
call in [`src/replyService.js`](./src/replyService.js) (unchanged).

- `CLOSED`: calls go through; calls and failures are counted.
- Trips to `OPEN` when `failures / calls >= failureThreshold` (default 0.5) **and**
  `calls >= minimumRequests` (default 5), so a single early error cannot trip it.
- `OPEN`: for `openMillis` (default 30 s) every call throws `CircuitOpenError` without touching the
  provider, and the reply service returns the human-queue fallback.
- `HALF_OPEN`: after the window, exactly **one** probe reaches the provider. Concurrent callers keep
  getting the fallback while it is in flight. Success → `CLOSED` with counts reset; failure → `OPEN`
  with a fresh window.

## 3. How to run / test

Node.js 18+ (no dependencies):

```bash
node --test
```

Expected: `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`. The 8 supplied tests are untouched; the 3 extra
tests live in `test/hardening.test.js`.

## 4. Evidence

| Test | Proves |
|---|---|
| `stays closed below the minimum request volume` | 4 failures < 5 minimum → still `CLOSED`, no trip |
| `opens once failures cross the threshold with enough volume` | 5/5 failures → `OPEN`, `breaker_open_total = 1` |
| `short-circuits without calling the dependency while open` | the provider function is never called; `short_circuited_total = 1` |
| `probes after the open window and closes on a successful probe` | at `openMillis` the probe runs and the breaker closes |
| `a failed probe re-opens the circuit` | failed probe → `OPEN`, `breaker_open_total = 2` |
| `reports state changes for observability` | `onStateChange` sees `OPEN → HALF_OPEN → CLOSED` |
| `half-open lets exactly one probe reach the provider` *(added)* | a second caller during a slow probe is short-circuited; provider called once |
| `a burst of 100 requests while open makes zero provider calls` *(added)* | 100 requests while open → still 5 provider calls, 100 short-circuits |
| `every transition emits one structured log event with no payload` *(added)* | one log event per transition; the ticket email, card text and error message never appear |
| `returns a model draft while the provider is healthy` | the healthy path is unaffected |
| `degrades to a safe fallback once the circuit opens` | caller gets `FALLBACK_TEXT` with `reason: 'circuit_open'` |

Passing output:

```text
✔ stays closed below the minimum request volume
✔ opens once failures cross the threshold with enough volume
✔ short-circuits without calling the dependency while open
✔ probes after the open window and closes on a successful probe
✔ a failed probe re-opens the circuit
✔ reports state changes for observability
✔ half-open lets exactly one probe reach the provider
✔ a burst of 100 requests while open makes zero provider calls
✔ every transition emits one structured log event with no payload
✔ returns a model draft while the provider is healthy
✔ degrades to a safe fallback once the circuit opens
ℹ tests 11
ℹ pass 11
ℹ fail 0
```

## 5. Observability note

**Metrics** (`breaker.metrics`, ready to export as counters):

- `breaker_open_total`: +1 on every trip to `OPEN`, including a failed probe. Alert if it rises.
- `short_circuited_total`: +1 for every request served the fallback without calling the provider.
  It shows how many users got the fallback.
- `success_total` / `failure_total`: provider outcomes, used for the failure rate.

**Log line:** every transition writes one JSON line (default sink: stderr, swappable with `log`) and
calls `onStateChange(state)`:

```json
{"event":"circuit_state_change","breaker":"model_provider","from":"CLOSED","to":"OPEN","reason":"failure_threshold_crossed","calls":5,"failures":5,"failure_rate":1,"breaker_open_total":1,"short_circuited_total":0,"at":0}
```

It holds only state names, a reason code, counts and a timestamp. It never logs the ticket, prompt,
provider response, error message, credentials or personal data. A test checks this.

## 6. Trade-off

- While `OPEN`, users whose request might have succeeded still get the fallback for up to
  `openMillis`. Recovery is delayed in return for protection.
- The thresholds need tuning: too sensitive and it trips on noise, too lax and it trips too late.
- Each extra user served by the fallback becomes work for a human agent.

## 7. Remaining risk

- Counts are **cumulative since the last close, not a rolling time window**. After a long healthy
  period, a sudden outage needs many failures before the rate reaches 50%. Next step: a sliding window
  (e.g. last 60 s or last N calls).
- **Slow calls are not failures.** A provider that hangs without erroring never trips the breaker.
  Next step: a per-call timeout that counts as a failure.
- State is **per process**. Each replica learns about the outage separately. A shared or
  gateway-level breaker would fix that.
- It treats every error the same. A `400` caused by a bad prompt counts the same as a `503`. Next
  step: only count retryable or provider-side errors.

## 8. How this production control protects my Modules 1–3 design

The PromptPilot design promises that `draftReply` **always answers**: a model draft, or a safe
"queued for a human agent" fallback. The support workflow never gets stuck on the AI step. Without the
breaker, a provider outage breaks that promise in practice: each request waits on a call that is
going to fail, latency climbs and the critical reply workflow backs up behind an optional dependency.
The breaker keeps the API contract (fast, predictable `{ source, text, reason }` responses) and keeps
the human-handoff workflow fed while the provider is down. The `reason: 'circuit_open'` field lets
downstream analytics tell "provider unhealthy" apart from "single provider error".
