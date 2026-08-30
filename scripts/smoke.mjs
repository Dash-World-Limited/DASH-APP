/**
 * End-to-end smoke test against a running API.
 *
 * Walks one order from browsing to delivery, then probes the authorization
 * boundaries that matter. Exits non-zero on the first failure.
 *
 *   npm run dev:api        # in one terminal
 *   node scripts/smoke.mjs # in another
 */

const BASE = process.env.API_URL ?? 'http://127.0.0.1:4000';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  [32mPASS[0m  ${label}`);
  } else {
    failed += 1;
    console.log(`  [31mFAIL[0m  ${label}`);
    if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 300)}`);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...options.headers,
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

function section(title) {
  console.log(`\n[1m${title}[0m`);
}

async function main() {
  console.log('\nDASH APP — end-to-end smoke test\n' + '='.repeat(50));

  // -------------------------------------------------------------------------
  section('Health');
  const health = await api('/health/ready');
  check('API is ready', health.status === 200, health.body);
  check(
    'payments are honestly reported as not live',
    health.body?.adapters?.paymentsLive === false,
    health.body?.adapters,
  );

  // -------------------------------------------------------------------------
  section('Discovery');
  const service = await api('/v1/serviceability?latitude=6.4281&longitude=3.4219');
  check('Victoria Island is serviceable', service.body?.serviceable === true, service.body);

  const swapped = await api('/v1/serviceability?latitude=3.4219&longitude=6.4281');
  check('swapped lat/lng is rejected', swapped.body?.serviceable === false, swapped.body);

  const vendors = await api('/v1/vendors?latitude=6.4281&longitude=3.4219');
  check('vendors are listed', (vendors.body?.vendors?.length ?? 0) >= 4, vendors.body);

  const firstVendor = vendors.body.vendors[0];
  const vendorDetail = await api(`/v1/vendors/${firstVendor.slug}`);
  check('vendor detail loads', vendorDetail.status === 200, vendorDetail.body);
  check(
    'vendor detail never exposes bank details',
    !('bankAccountCipher' in (vendorDetail.body?.vendor ?? {})) &&
      !('commissionBasisPoints' in (vendorDetail.body?.vendor ?? {})),
    Object.keys(vendorDetail.body?.vendor ?? {}),
  );

  // -------------------------------------------------------------------------
  section('Customer sign-in (OTP)');
  const otpRequest = await api('/v1/auth/otp/request', {
    method: 'POST',
    body: { phone: '+2347000000201' },
  });
  check('OTP request accepted', otpRequest.body?.sent === true, otpRequest.body);

  const unknownNumber = await api('/v1/auth/otp/request', {
    method: 'POST',
    body: { phone: '+2347999999999' },
  });
  // `devCode` is present only when DEV_EXPOSE_OTP is on, which config.ts
  // forbids in production. Compare the production-shaped response: everything
  // except that field must be byte-identical for a known and unknown number.
  const withoutDevCode = (body) => {
    const { devCode: _devCode, ...rest } = body ?? {};
    return JSON.stringify(rest);
  };
  check(
    'unknown number gets an identical response (no enumeration)',
    withoutDevCode(unknownNumber.body) === withoutDevCode(otpRequest.body),
    { known: otpRequest.body, unknown: unknownNumber.body },
  );
  check(
    'no code is ever returned for a number with no account',
    unknownNumber.body?.devCode === undefined,
    unknownNumber.body,
  );

  const otp = process.env.OTP ?? otpRequest.body?.devCode;
  if (!otp) {
    console.log('\n  [33mNo OTP available. Set DEV_EXPOSE_OTP=true, or pass OTP=<code>.[0m');
    return summary();
  }

  const verify = await api('/v1/auth/otp/verify', {
    method: 'POST',
    body: { phone: '+2347000000201', code: otp },
  });
  check('OTP verifies and returns tokens', verify.status === 200 && !!verify.body.accessToken, verify.body);
  if (!verify.body.accessToken) return summary();

  const customerToken = verify.body.accessToken;

  const me = await api('/v1/auth/me', { token: customerToken });
  check('customer profile loads', me.body?.roles?.includes('customer'), me.body);
  check(
    'customer holds no admin permissions',
    !me.body.permissions.some((p) => p.startsWith('admin:') || p.startsWith('finance:')),
    me.body.permissions,
  );

  // -------------------------------------------------------------------------
  section('Quote and checkout');
  const branch = vendorDetail.body.vendor.branches[0];
  const item = vendorDetail.body.vendor.categories[0].items[0];
  const requiredGroup = item.modifierGroups?.find((g) => g.minSelect > 0);
  const modifierIds = requiredGroup ? [requiredGroup.options[0].id] : [];

  const history = await api('/v1/orders', { token: customerToken });
  check('order history loads', history.status === 200, history.body);

  const addressList = await api('/v1/addresses', { token: customerToken });
  check('saved addresses load', (addressList.body?.addresses?.length ?? 0) > 0, addressList.body);
  const addressId = addressList.body?.addresses?.[0]?.id;

  const quoteBody = {
    branchId: branch.id,
    items: [{ itemId: item.id, quantity: 2, modifierIds }],
    mode: 'delivery',
    addressId,
  };

  // Quote without an address must fail cleanly.
  const noAddress = await api('/v1/orders/quote', {
    method: 'POST',
    token: customerToken,
    body: { ...quoteBody, addressId: undefined },
  });
  check('delivery quote without an address is rejected', noAddress.status === 400, noAddress.body);

  // Price tampering: the client cannot send a price at all, but prove that an
  // injected price field is ignored rather than honoured.
  const tampered = await api('/v1/orders/quote', {
    method: 'POST',
    token: customerToken,
    body: { ...quoteBody, mode: 'pickup', itemsSubtotal: 1, total: 1, price: 1 },
  });
  check(
    'injected price fields are ignored — server prices from the database',
    tampered.status === 200 && tampered.body.quote.itemsSubtotal === item.price * 2 + (requiredGroup ? requiredGroup.options[0].priceDelta * 2 : 0),
    { sent: 1, got: tampered.body?.quote?.itemsSubtotal, expected: item.price * 2 },
  );

  const badQuantity = await api('/v1/orders/quote', {
    method: 'POST',
    token: customerToken,
    body: { ...quoteBody, mode: 'pickup', items: [{ itemId: item.id, quantity: -5, modifierIds }] },
  });
  check('negative quantity is rejected', badQuantity.status === 400, badQuantity.body);

  const foreignItem = await api('/v1/orders/quote', {
    method: 'POST',
    token: customerToken,
    body: {
      ...quoteBody,
      mode: 'pickup',
      items: [{ itemId: 'does-not-exist', quantity: 1, modifierIds: [] }],
    },
  });
  check('unknown item id is rejected', foreignItem.status === 422, foreignItem.body);

  const goodQuote = await api('/v1/orders/quote', {
    method: 'POST',
    token: customerToken,
    body: quoteBody,
  });
  check('a valid delivery quote succeeds', goodQuote.status === 200, goodQuote.body);
  check(
    'the quote explains every line it charges',
    (goodQuote.body?.quote?.lines?.length ?? 0) >= 2 &&
      goodQuote.body.quote.lines.every((line) => line.explanation?.length > 0),
    goodQuote.body?.quote?.lines,
  );
  check(
    'quote lines sum exactly to the total',
    goodQuote.body?.quote?.lines?.reduce((sum, line) => sum + line.amount, 0) ===
      goodQuote.body?.quote?.total,
    goodQuote.body?.quote,
  );

  // -------------------------------------------------------------------------
  section('Order lifecycle');
  const idempotencyKey = `smoke-${Date.now()}`;
  const checkout = await api('/v1/orders', {
    method: 'POST',
    token: customerToken,
    idempotencyKey,
    body: { ...quoteBody, paymentMethod: 'card' },
  });
  check('checkout places the order', checkout.status === 200 && !!checkout.body.order?.id, checkout.body);
  const orderId = checkout.body?.order?.id;
  const deliveryPin = checkout.body?.deliveryPin;
  check('a delivery PIN is issued to the customer', /^\d{4}$/.test(deliveryPin ?? ''), {
    deliveryPin: deliveryPin ? 'present' : 'missing',
  });

  if (!orderId) return summary();

  const replay = await api('/v1/orders', {
    method: 'POST',
    token: customerToken,
    idempotencyKey,
    body: { ...quoteBody, paymentMethod: 'card' },
  });
  check(
    'replaying the same Idempotency-Key does not place a second order',
    replay.body?.order?.id === orderId,
    { first: orderId, replayed: replay.body?.order?.id },
  );

  const placed = await api(`/v1/orders/${orderId}`, { token: customerToken });
  check('order reaches "placed" after payment capture', placed.body?.order?.status === 'placed', {
    status: placed.body?.order?.status,
  });
  check(
    'the order never echoes back the delivery PIN',
    !JSON.stringify(placed.body).includes(deliveryPin),
    'PIN found in order payload',
  );

  // --- Vendor accepts -------------------------------------------------------
  const vendorLogin = await api('/v1/auth/login', {
    method: 'POST',
    body: { email: `${firstVendor.slug}@dashapp.test`, password: 'DashDev!2026' },
  });
  const vendorToken = vendorLogin.body.accessToken;
  check('vendor owner signs in', !!vendorToken, vendorLogin.body);

  const queue = await api('/v1/vendor/orders?status=incoming', { token: vendorToken });
  check(
    'the order appears in the vendor queue',
    queue.body?.orders?.some((o) => o.id === orderId),
    queue.body?.orders?.map((o) => o.code),
  );
  check(
    'the vendor never sees the customer phone number',
    !JSON.stringify(queue.body).includes('+234700000020'),
    'customer phone leaked to vendor',
  );

  const accept = await api(`/v1/vendor/orders/${orderId}/accept`, {
    method: 'POST',
    token: vendorToken,
    body: { prepMinutes: 20 },
  });
  check('vendor accepts the order', accept.body?.accepted === true, accept.body);

  const doubleAccept = await api(`/v1/vendor/orders/${orderId}/accept`, {
    method: 'POST',
    token: vendorToken,
    body: { prepMinutes: 20 },
  });
  check(
    'accepting twice is rejected by the state machine',
    doubleAccept.status === 409,
    doubleAccept.body,
  );

  const progress = await api(`/v1/vendor/orders/${orderId}/progress`, {
    method: 'POST',
    token: vendorToken,
    body: { to: 'preparing' },
  });
  check('vendor marks the order preparing', progress.body?.status === 'preparing', progress.body);

  const skipAhead = await api(`/v1/vendor/orders/${orderId}/progress`, {
    method: 'POST',
    token: vendorToken,
    body: { to: 'preparing' },
  });
  check('repeating a transition is rejected', skipAhead.status === 409, skipAhead.body);

  // --- Cross-tenant probe ---------------------------------------------------
  const otherVendor = vendors.body.vendors.find((v) => v.slug !== firstVendor.slug);
  const otherLogin = await api('/v1/auth/login', {
    method: 'POST',
    body: { email: `${otherVendor.slug}@dashapp.test`, password: 'DashDev!2026' },
  });
  const otherVendorToken = otherLogin.body.accessToken;

  const crossTenant = await api(`/v1/vendor/orders/${orderId}/accept`, {
    method: 'POST',
    token: otherVendorToken,
    body: { prepMinutes: 20 },
  });
  check(
    "a competitor vendor cannot touch another vendor's order",
    crossTenant.status === 404,
    crossTenant.body,
  );
  check(
    'the cross-tenant refusal says "Not found", not "Forbidden"',
    crossTenant.body?.error?.message === 'Not found.',
    crossTenant.body?.error,
  );

  const crossTenantRead = await api(`/v1/orders/${orderId}`, { token: otherVendorToken });
  check('a competitor cannot read the order either', crossTenantRead.status >= 400, crossTenantRead.status);

  // -------------------------------------------------------------------------
  section('Authorization boundaries');
  const staffLogin = await api('/v1/auth/login', {
    method: 'POST',
    body: { email: 'admin@dashapp.test', password: 'DashDev!2026' },
  });
  const adminToken = staffLogin.body.accessToken;
  check('super admin signs in', !!adminToken, staffLogin.body);

  const customerHitsOps = await api('/v1/ops/live', { token: customerToken });
  check('customer cannot read the ops live board', customerHitsOps.status === 403, customerHitsOps.body);

  const customerHitsVendor = await api('/v1/vendor/orders', { token: customerToken });
  check('customer cannot read the vendor queue', customerHitsVendor.status === 403, customerHitsVendor.body);

  const customerHitsAudit = await api('/v1/admin/audit', { token: customerToken });
  check('customer cannot read the audit log', customerHitsAudit.status === 403, customerHitsAudit.body);

  const noToken = await api('/v1/orders');
  check('unauthenticated order history is rejected', noToken.status === 401, noToken.body);

  const badToken = await api('/v1/orders', { token: 'not-a-real-token' });
  check('a forged token is rejected', badToken.status === 401, badToken.body);

  // Step-up: an admin with every permission still cannot approve a payout
  // without a recent identity check.
  const payoutWithoutStepUp = await api('/v1/finance/orders/x/refund', {
    method: 'POST',
    token: adminToken,
    body: { amount: 100, reason: 'testing step-up enforcement' },
  });
  check(
    'super admin still needs step-up for a refund',
    payoutWithoutStepUp.status === 403 &&
      payoutWithoutStepUp.body?.error?.code === 'step_up_required',
    payoutWithoutStepUp.body,
  );

  // -------------------------------------------------------------------------
  section('Ledger integrity');
  const integrity = await api('/v1/finance/ledger/integrity', { token: adminToken });
  check('ledger integrity endpoint is reachable by admin', integrity.status === 200, integrity.body);
  check('every ledger transaction balances', integrity.body?.balanced === true, integrity.body);
  check('there is no money drift', integrity.body?.totalDriftKobo === 0, integrity.body);

  // -------------------------------------------------------------------------
  section('Webhook hardening');
  const unsigned = await api('/v1/webhooks/payments', {
    method: 'POST',
    body: { id: 'evt_forged', type: 'charge.success', reference: 'DASH-XXXXXX', amount: 999_999 },
  });
  check(
    'an unsigned webhook is answered 200 and does nothing',
    unsigned.status === 200 && unsigned.body?.processed !== true,
    unsigned.body,
  );

  summary();
}

function summary() {
  console.log('\n' + '='.repeat(50));
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
