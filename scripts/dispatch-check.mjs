/**
 * Dispatch loop check.
 *
 * Proves the piece that was missing until Milestone 4: that a paid order
 * actually reaches a rider, that the rider can accept it, and that the delivery
 * completes with a PIN. Requires a running API and a seeded database.
 *
 *   node scripts/dispatch-check.mjs
 */

const BASE = process.env.API_URL ?? 'http://127.0.0.1:4000';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [32mPASS[0m  ${label}`);
  } else {
    failed += 1;
    console.log(`  [31mFAIL[0m  ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 400)}`);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function signInByOtp(phone) {
  const request = await api('/v1/auth/otp/request', { method: 'POST', body: { phone } });
  const code = request.body?.devCode;
  if (!code) throw new Error(`No devCode for ${phone}. Is DEV_EXPOSE_OTP=true?`);
  const verify = await api('/v1/auth/otp/verify', { method: 'POST', body: { phone, code } });
  return verify.body.accessToken;
}

async function main() {
  console.log('\nDASH APP — dispatch loop check\n' + '='.repeat(50));

  // -------------------------------------------------------------------------
  console.log('\n[1mBring a rider online[0m');
  // Kunle Balogun works the Yaba zone, where Iya Kemi Kitchen is. A rider whose
  // allowed zones exclude the vendor is correctly refused the offer, so the
  // check would fail for the right reason with the wrong rider.
  const riderToken = await signInByOtp('+2347000000303');
  check('rider signs in', !!riderToken);

  const online = await api('/v1/rider/availability', {
    method: 'POST',
    token: riderToken,
    body: { availability: 'idle' },
  });
  check('rider goes online', online.body?.availability === 'idle', online.body);

  // A rider with no recent location is excluded by the dispatch engine, so
  // report one near the Yaba vendor before expecting any offer.
  const location = await api('/v1/rider/location', {
    method: 'POST',
    token: riderToken,
    body: { latitude: 6.5098, longitude: 3.3715, accuracy: 12 },
  });
  check('rider location accepted', location.body?.accepted === true, location.body);

  const teleport = await api('/v1/rider/location', {
    method: 'POST',
    token: riderToken,
    body: { latitude: 6.6018, longitude: 3.3515, accuracy: 12 },
  });
  check(
    'an implausible jump is rejected, not silently trusted',
    teleport.body?.accepted === false && teleport.body?.reason === 'implausible_movement',
    teleport.body,
  );

  // -------------------------------------------------------------------------
  console.log('\n[1mPlace an order[0m');
  const customerToken = await signInByOtp('+2347000000201');
  const addresses = await api('/v1/addresses', { token: customerToken });
  const addressId = addresses.body?.addresses?.[0]?.id;

  const vendors = await api('/v1/vendors');
  const kitchen = vendors.body.vendors.find((v) => v.slug === 'iya-kemi-kitchen');
  const detail = await api(`/v1/vendors/${kitchen.slug}`);
  const branch = detail.body.vendor.branches[0];
  const item = detail.body.vendor.categories[0].items[0];
  const group = item.modifierGroups?.find((g) => g.minSelect > 0);

  const order = await api('/v1/orders', {
    method: 'POST',
    token: customerToken,
    idempotencyKey: `dispatch-check-${Date.now()}`,
    body: {
      branchId: branch.id,
      items: [
        { itemId: item.id, quantity: 1, modifierIds: group ? [group.options[0].id] : [] },
      ],
      mode: 'delivery',
      addressId,
      paymentMethod: 'card',
    },
  });
  check('order is placed', order.status === 200 && !!order.body.order?.id, order.body);
  const orderId = order.body?.order?.id;
  const deliveryPin = order.body?.deliveryPin;
  if (!orderId) return summary();

  // -------------------------------------------------------------------------
  console.log('\n[1mVendor accepts[0m');
  const vendorLogin = await api('/v1/auth/login', {
    method: 'POST',
    body: { email: 'iya-kemi-kitchen@dashapp.test', password: 'DashDev!2026' },
  });
  const vendorToken = vendorLogin.body.accessToken;

  const accept = await api(`/v1/vendor/orders/${orderId}/accept`, {
    method: 'POST',
    token: vendorToken,
    // A short prep time so the dispatch job is scheduled immediately rather
    // than minutes from now.
    body: { prepMinutes: 1 },
  });
  check('vendor accepts the order', accept.body?.accepted === true, accept.body);

  // -------------------------------------------------------------------------
  console.log('\n[1mDispatch reaches the rider[0m');
  let offer = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await sleep(1000);
    const offers = await api('/v1/rider/offers', { token: riderToken });
    offer = offers.body?.offers?.find((entry) => entry.order.code === order.body.order.code);
    if (offer) break;
  }

  check('the rider receives an offer for this order', offer !== null && offer !== undefined, {
    hint: 'the dispatch worker did not produce an offer within 25s',
  });
  if (!offer) return summary();

  check(
    'the offer shows pickup detail and a countdown',
    !!offer.order.pickup?.address && new Date(offer.expiresAt).getTime() > Date.now(),
    offer,
  );
  check(
    'the exact drop-off address is NOT revealed before accepting',
    offer.order.dropoffArea !== null &&
      // Coarsened to 3dp, so it is an area rather than a doorstep.
      String(offer.order.dropoffArea.latitude).split('.')[1]?.length <= 3,
    offer.order.dropoffArea,
  );

  // -------------------------------------------------------------------------
  console.log('\n[1mRider completes the delivery[0m');
  const accepted = await api(`/v1/rider/offers/${offer.id}/respond`, {
    method: 'POST',
    token: riderToken,
    body: { accept: true },
  });
  check('rider accepts the offer', accepted.body?.accepted === true, accepted.body);

  const delivery = await api(`/v1/rider/deliveries/${orderId}`, { token: riderToken });
  check(
    'the full address IS revealed once assigned',
    !!delivery.body?.delivery?.address?.line1,
    delivery.body,
  );

  for (const step of ['rider_arrived', 'picked_up', 'en_route']) {
    const progress = await api(`/v1/rider/deliveries/${orderId}/progress`, {
      method: 'POST',
      token: riderToken,
      body: { to: step },
    });
    check(`rider advances to ${step}`, progress.body?.status === step, progress.body);
  }

  const wrongPin = await api(`/v1/rider/deliveries/${orderId}/complete`, {
    method: 'POST',
    token: riderToken,
    body: { pin: deliveryPin === '0000' ? '1111' : '0000' },
  });
  check(
    'a wrong PIN cannot complete the delivery',
    wrongPin.status === 400,
    wrongPin.body,
  );

  const completed = await api(`/v1/rider/deliveries/${orderId}/complete`, {
    method: 'POST',
    token: riderToken,
    body: { pin: deliveryPin, latitude: 6.4478, longitude: 3.4361 },
  });
  check('the correct PIN completes the delivery', completed.body?.delivered === true, completed.body);

  const final = await api(`/v1/orders/${orderId}`, { token: customerToken });
  check('the customer sees it as delivered', final.body?.order?.status === 'delivered', {
    status: final.body?.order?.status,
  });

  // -------------------------------------------------------------------------
  console.log('\n[1mRider earnings and ledger[0m');
  const earnings = await api('/v1/rider/earnings', { token: riderToken });
  check('rider has a positive balance owed', (earnings.body?.balanceOwed ?? 0) > 0, earnings.body);

  const finance = await api('/v1/auth/login', {
    method: 'POST',
    body: { email: 'finance@dashapp.test', password: 'DashDev!2026' },
  });
  const integrity = await api('/v1/finance/ledger/integrity', {
    token: finance.body.accessToken,
  });
  check('the ledger still balances after a full delivery', integrity.body?.balanced === true, integrity.body);
  check('no money drift', integrity.body?.totalDriftKobo === 0, integrity.body);

  summary();
}

function summary() {
  console.log('\n' + '='.repeat(50));
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\nDispatch check crashed:', error);
  process.exit(1);
});
