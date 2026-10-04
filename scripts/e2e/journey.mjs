/**
 * The P0 journey, end to end, against a running DASH API.
 *
 * Run it with `npm run e2e:journey` (scripts/e2e/run.mjs starts a throwaway
 * database and API for it). Every action is an HTTP call a client makes — a
 * customer, a vendor owner and a rider in turn; the database is read only to
 * pick the seeded store and a rider whose zone covers it.
 *
 * Mock payment and console email (codes come back in development responses),
 * so it needs no keys and moves no money.
 */
import { PrismaClient } from '@prisma/client';

const API = process.env.JOURNEY_API ?? 'http://127.0.0.1:4100';
const prisma = new PrismaClient();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let step = 0;
const ok = (label) => log(`PASS ${String(++step).padStart(2, '0')} ${label}`);
function fail(label, detail) {
  log(`FAIL ${String(++step).padStart(2, '0')} ${label}`, detail ?? '');
  process.exitCode = 1;
  throw new Error(label);
}

async function call(method, path, { token, body, headers } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: response.status, json, text };
}

async function signInByEmail(email) {
  const requested = await call('POST', '/v1/auth/otp/request', { body: { email, purpose: 'login' } });
  if (requested.status !== 200 || !requested.json?.devCode) fail(`code requested for ${email}`, requested.text);
  const verified = await call('POST', '/v1/auth/otp/verify', { body: { email, code: requested.json.devCode, purpose: 'login' } });
  if (verified.status !== 200 || !verified.json?.accessToken) fail(`signed in as ${email}`, verified.text);
  return verified.json.accessToken;
}

const until = async (what, fn, ms = 30_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(what, `not within ${ms / 1000}s`);
};

try {
  // --- setup: pick the store and a rider who may serve it ---------------------
  const vendor = await prisma.vendor.findFirstOrThrow({
    where: { slug: 'iya-kemi-kitchen' },
    include: { branches: true },
  });
  const branch = vendor.branches[0];
  await prisma.branch.update({ where: { id: branch.id }, data: { state: 'open' } });
  const riders = await prisma.rider.findMany({ where: { status: 'approved' }, include: { identity: true } });
  const rider = riders.find((r) => {
    const zones = r.allowedZoneIds ? JSON.parse(r.allowedZoneIds) : [];
    return r.identity.email && (zones.length === 0 || zones.includes(branch.zoneId));
  });
  if (!rider) fail('a seeded rider can serve the store');
  log(`store ${vendor.name} (${branch.latitude},${branch.longitude}); rider ${rider.identity.email}`);

  // --- customer: register and verify ------------------------------------------
  const email = `journey-${Date.now()}@dashapp.test`;
  const signup = await call('POST', '/v1/auth/signup', {
    body: {
      name: 'Journey Customer', email, phone: `+23480${String(Date.now()).slice(-8)}`,
      state: 'Lagos', cityArea: 'Victoria Island', usageIntent: 'mainly_buying',
      acquisitionSource: 'social_media', confirmedAdult: true, acceptedTerms: true,
    },
  });
  if (signup.status !== 200 || !signup.json?.devCode) fail('customer signs up', signup.text);
  ok('customer signs up; a 6-digit code is issued to the email');

  const wrong = await call('POST', '/v1/auth/email/verify', { body: { email, code: '000000' } });
  if (wrong.status < 400) fail('a wrong code is refused', wrong.text);
  ok(`a wrong code is refused (${wrong.status})`);

  const verified = await call('POST', '/v1/auth/email/verify', { body: { email, code: signup.json.devCode } });
  if (verified.status !== 200 || !verified.json?.accessToken) fail('the right code signs the customer in', verified.text);
  const customer = verified.json.accessToken;
  ok('the right code verifies the email and signs the customer in');

  const me = await call('GET', '/v1/auth/me', { token: customer });
  if (me.json?.phone?.verification !== 'unverified') fail('phone reported unverified', me.text);
  ok(`phone reported as "${me.json.phone.verification}" — "${me.json.phone.notice}"`);

  // --- browse, address, quote, checkout ----------------------------------------
  const store = await call('GET', `/v1/vendors/${vendor.slug}`);
  if (store.status !== 200) fail('storefront loads', store.text);
  const item = store.json.vendor.categories.flatMap((c) => c.items).find((i) => i.isAvailable !== false);
  const modifierIds = (item.modifierGroups ?? []).filter((g) => g.minSelect > 0).map((g) => g.options[0].id);
  ok(`storefront loads; chose "${item.name}"`);

  const address = await call('POST', '/v1/addresses', {
    token: customer,
    body: { line1: '12 Journey Street', contactPhone: '+2348031234567', latitude: branch.latitude + 0.004, longitude: branch.longitude + 0.004, isDefault: true },
  });
  if (address.status !== 200) fail('address saved', address.text);
  const addressId = address.json.address.id;
  ok('delivery address saved (inside a delivery zone)');

  const basket = { branchId: branch.id, items: [{ itemId: item.id, quantity: 2, modifierIds }], mode: 'delivery', addressId };
  const quote = await call('POST', '/v1/orders/quote', { token: customer, body: basket });
  if (quote.status !== 200) fail('quote', quote.text);
  ok(`server quote: total ₦${(quote.json.quote.total / 100).toFixed(2)} (items ${quote.json.quote.itemsSubtotal / 100}, delivery ${quote.json.quote.deliveryFee / 100})`);

  const cash = await call('POST', '/v1/orders', { token: customer, body: { ...basket, paymentMethod: 'cash' }, headers: { 'idempotency-key': `cash-${Date.now()}` } });
  if (cash.status !== 422) fail('cash is refused', cash.text);
  ok('cash is refused (422)');

  const key = `journey-${Date.now()}`;
  const placed = await call('POST', '/v1/orders', { token: customer, body: { ...basket, paymentMethod: 'card' }, headers: { 'idempotency-key': key } });
  if (placed.status !== 200) fail('checkout', placed.text);
  const again = await call('POST', '/v1/orders', { token: customer, body: { ...basket, paymentMethod: 'card' }, headers: { 'idempotency-key': key } });
  if (again.json?.order?.id !== placed.json.order.id) fail('a repeated checkout returns the same order', again.text);
  const orderId = placed.json.order.id;
  const pin = placed.json.deliveryPin;
  ok(`checkout placed order ${placed.json.order.code} (mock payment: ${placed.json.payment.status}); repeating the request returned the same order`);

  const verify = await call('POST', `/v1/orders/${orderId}/payment/verify`, { token: customer });
  if (verify.json?.payment?.outcome !== 'captured' || verify.json?.order?.status !== 'placed') fail('server verification', verify.text);
  ok(`server-side verification: ${verify.json.payment.outcome}, order ${verify.json.order.status}`);

  // --- vendor ------------------------------------------------------------------
  const vendorToken = await signInByEmail('iya-kemi-kitchen@dashapp.test');
  ok('vendor owner signs in by emailed code');
  const queue = await call('GET', '/v1/vendor/orders', { token: vendorToken });
  const inQueue = JSON.stringify(queue.json).includes(orderId);
  if (!inQueue) fail('order in the vendor queue', queue.text.slice(0, 300));
  ok('order appears in the vendor queue');
  const accepted = await call('POST', `/v1/vendor/orders/${orderId}/accept`, { token: vendorToken, body: { prepMinutes: 15 } });
  if (accepted.status !== 200) fail('vendor accepts', accepted.text);
  ok('vendor accepts with a 15-minute preparation time');

  // --- rider goes online before preparation starts (that triggers dispatch) ----
  const riderToken = await signInByEmail(rider.identity.email);
  ok(`rider ${rider.identity.email} signs in by emailed code`);
  const online = await call('POST', '/v1/rider/availability', { token: riderToken, body: { availability: 'idle' } });
  if (online.status !== 200) fail('rider goes online', online.text);
  const located = await call('POST', '/v1/rider/location', { token: riderToken, body: { latitude: branch.latitude + 0.001, longitude: branch.longitude + 0.001, accuracy: 10, recordedAt: new Date().toISOString() } });
  if (located.status >= 400) fail('rider reports a position', located.text);
  ok('rider goes online and reports a fresh position near the store');

  const preparing = await call('POST', `/v1/vendor/orders/${orderId}/progress`, { token: vendorToken, body: { to: 'preparing' } });
  if (preparing.status !== 200) fail('vendor marks preparing', preparing.text);
  ok('vendor marks the order preparing (this starts dispatch)');

  const offer = await until('the rider receives an offer', async () => {
    await call('POST', '/v1/rider/location', { token: riderToken, body: { latitude: branch.latitude + 0.001, longitude: branch.longitude + 0.001, accuracy: 10, recordedAt: new Date().toISOString() } });
    const offers = await call('GET', '/v1/rider/offers', { token: riderToken });
    return offers.json?.offers?.find((o) => o.order.code === placed.json.order.code);
  });
  if (JSON.stringify(offer).includes('12 Journey Street')) fail('offer hides the address before acceptance');
  ok(`rider receives the offer; it shows the drop-off area only, not the address`);

  const accept = await call('POST', `/v1/rider/offers/${offer.id}/respond`, { token: riderToken, body: { accept: true } });
  if (accept.status !== 200 || accept.json?.orderId !== orderId) fail('rider accepts', accept.text);
  const again2 = await call('POST', `/v1/rider/offers/${offer.id}/respond`, { token: riderToken, body: { accept: true } });
  if (again2.status < 400) fail('a second acceptance of the same offer is refused', again2.text);
  ok(`rider accepts; accepting again is refused (${again2.status})`);

  const job = await call('GET', `/v1/rider/deliveries/${orderId}`, { token: riderToken });
  if (!JSON.stringify(job.json).includes('12 Journey Street')) fail('address revealed after acceptance', job.text);
  ok('after acceptance the rider sees the delivery address');

  const ready = await call('POST', `/v1/vendor/orders/${orderId}/progress`, { token: vendorToken, body: { to: 'ready' } });
  if (ready.status !== 200) fail('vendor marks ready', ready.text);
  ok(`vendor marks the food ready (order stays ${ready.json.status}, the rider's status)`);
  const pickupCode = job.json.delivery.pickupCode;
  if (!/^\d{4}$/.test(pickupCode ?? '')) fail('rider is shown a pickup code', job.text);
  const checked = await call('POST', `/v1/vendor/orders/${orderId}/verify-pickup`, { token: vendorToken, body: { code: pickupCode } });
  if (checked.status !== 200) fail('vendor verifies the pickup code the rider shows', checked.text);
  ok('vendor verifies the pickup code the rider is shown');

  for (const to of ['rider_arrived', 'picked_up', 'en_route', 'arrived']) {
    const moved = await call('POST', `/v1/rider/deliveries/${orderId}/progress`, { token: riderToken, body: { to } });
    if (moved.status !== 200) fail(`rider: ${to}`, moved.text);
    const seen = await call('GET', `/v1/orders/${orderId}`, { token: customer });
    ok(`rider: ${to} — customer sees "${seen.json.order.statusLabel}"`);
  }

  const wrongPin = await call('POST', `/v1/rider/deliveries/${orderId}/complete`, { token: riderToken, body: { pin: pin === '0000' ? '1111' : '0000' } });
  if (wrongPin.status < 400) fail('a wrong PIN is refused', wrongPin.text);
  ok(`a wrong delivery PIN is refused (${wrongPin.status})`);
  const done = await call('POST', `/v1/rider/deliveries/${orderId}/complete`, { token: riderToken, body: { pin } });
  if (done.status !== 200) fail('the customer’s PIN completes the delivery', done.text);
  ok('the customer’s PIN completes the delivery');

  const final = await call('GET', `/v1/orders/${orderId}`, { token: customer });
  if (final.json?.order?.status !== 'delivered') fail('customer sees delivered', final.text);
  const history = await call('GET', '/v1/orders?status=past', { token: customer });
  if (!JSON.stringify(history.json).includes(orderId)) fail('order in history');
  ok(`customer sees "${final.json.order.statusLabel}" and the order in their history`);

  const ledger = await call('GET', '/v1/rider/earnings', { token: riderToken });
  ok(`rider earnings from the ledger: owed ₦${(ledger.json.balanceOwed / 100).toFixed(2)}, ${ledger.json.completedDeliveries} completed`);

  // --- authorization: nobody reaches what is not theirs ------------------------
  const strangerEmail = `stranger-${Date.now()}@dashapp.test`;
  const s1 = await call('POST', '/v1/auth/signup', { body: { name: 'Stranger', email: strangerEmail, phone: `+23481${String(Date.now()).slice(-8)}`, state: 'Lagos', cityArea: 'Yaba', usageIntent: 'mainly_buying', acquisitionSource: 'social_media', confirmedAdult: true, acceptedTerms: true } });
  const s2 = await call('POST', '/v1/auth/email/verify', { body: { email: strangerEmail, code: s1.json.devCode } });
  const stranger = s2.json.accessToken;
  const peek = await call('GET', `/v1/orders/${orderId}`, { token: stranger });
  const vendorPeek = await call('GET', '/v1/vendor/orders', { token: stranger });
  const riderPeek = await call('GET', '/v1/rider/offers', { token: stranger });
  const adminPeek = await call('GET', '/v1/admin/vendor-applications', { token: stranger });
  if (peek.status !== 404 || vendorPeek.status !== 403 || riderPeek.status !== 403 || adminPeek.status !== 403) {
    fail('a stranger is refused everywhere', `${peek.status} ${vendorPeek.status} ${riderPeek.status} ${adminPeek.status}`);
  }
  ok(`another customer is refused: their order 404, vendor 403, rider 403, admin 403`);

  // --- account deletion ---------------------------------------------------------
  const noStepUp = await call('POST', '/v1/account/deletion', { token: customer, body: {}, headers: { 'idempotency-key': `del-${Date.now()}` } });
  if (noStepUp.status !== 403) fail('deletion needs a fresh confirmation', noStepUp.text);
  const stepCode = await call('POST', '/v1/auth/otp/request', { token: customer, body: { email, purpose: 'step_up' } });
  const stepped = await call('POST', '/v1/auth/otp/verify', { token: customer, body: { email, code: stepCode.json.devCode, purpose: 'step_up' } });
  if (!stepped.json?.steppedUp) fail('step-up by emailed code', stepped.text);
  const deletion = await call('POST', '/v1/account/deletion', { token: customer, body: {}, headers: { 'idempotency-key': `del-${Date.now()}` } });
  if (deletion.json?.deletion?.status !== 'scheduled') fail('deletion scheduled', deletion.text);
  const cancelled = await call('DELETE', '/v1/account/deletion', { token: customer });
  if (cancelled.status !== 200) fail('deletion cancelled', cancelled.text);
  ok(`account deletion refused without confirmation (403), scheduled after an emailed code for ${deletion.json.deletion.scheduledPurgeAt.slice(0, 10)}, then cancelled`);

  log(`\nALL ${step} STEPS PASSED`);
} catch (error) {
  if (!process.exitCode) {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
