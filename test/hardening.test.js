// Extra evidence for the proof slice. The supplied tests are left untouched;
// these cover the single-probe rule and the safety of the log line.
const { test } = require('node:test');
const assert = require('node:assert');
const { createCircuitBreaker, CircuitOpenError } = require('../src/circuitBreaker');
const { createReplyService } = require('../src/replyService');

const SECRET_TICKET = { id: 7, email: 'customer@example.com', body: 'my card is 4242...' };

async function trip(cb) {
  for (let i = 0; i < 5; i++) {
    await cb.exec(() => Promise.reject(new Error('provider down'))).catch(() => {});
  }
}

test('half-open lets exactly one probe reach the provider', async () => {
  let clock = 0;
  const cb = createCircuitBreaker({ openMillis: 1000, now: () => clock, log: () => {} });
  await trip(cb);
  clock = 1000;

  let providerCalls = 0;
  let release;
  const slowProbe = () => {
    providerCalls += 1;
    return new Promise((resolve) => { release = () => resolve('drafted'); });
  };

  const probe = cb.exec(slowProbe);
  await assert.rejects(() => cb.exec(slowProbe), CircuitOpenError);
  release();
  assert.equal(await probe, 'drafted');
  assert.equal(providerCalls, 1);
  assert.equal(cb.state, 'CLOSED');
});

test('a burst of 100 requests while open makes zero provider calls', async () => {
  let providerCalls = 0;
  const svc = createReplyService(
    () => { providerCalls += 1; return Promise.reject(new Error('provider down')); },
    { openMillis: 1000, now: () => 0, log: () => {} }
  );
  for (let i = 0; i < 5; i++) await svc.draftReply({ id: i });
  assert.equal(providerCalls, 5);

  for (let i = 0; i < 100; i++) await svc.draftReply({ id: i });
  assert.equal(providerCalls, 5);
  assert.equal(svc.breaker.metrics.short_circuited_total, 100);
});

test('every transition emits one structured log event with no payload', async () => {
  const events = [];
  let clock = 0;
  const svc = createReplyService(
    (ticket) => (clock < 1000 ? Promise.reject(new Error(`failed for ${ticket.email}`)) : Promise.resolve('ok')),
    { openMillis: 1000, now: () => clock, log: (e) => events.push(e) }
  );
  for (let i = 0; i < 5; i++) await svc.draftReply(SECRET_TICKET);
  clock = 1000;
  await svc.draftReply(SECRET_TICKET);

  assert.deepEqual(events.map((e) => `${e.from}->${e.to}`), ['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
  assert.equal(events[0].event, 'circuit_state_change');
  assert.equal(events[0].reason, 'failure_threshold_crossed');
  assert.equal(events[0].failure_rate, 1);

  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('customer@example.com'));
  assert.ok(!serialized.includes('4242'));
  assert.ok(!serialized.includes('provider down'));
});
