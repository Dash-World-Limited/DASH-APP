/**
 * Idempotent staging data for testing a real rider in Asaba.
 *
 * This creates a clearly labelled demo market, vendor, item, and customer
 * address. It is not the permanent Lagos/Delta state-boundary implementation.
 */
const { PrismaClient } = require('@prisma/client');

if (!process.argv.includes('--apply')) {
  throw new Error('Safety stop: rerun with --apply after reviewing this script');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/dashdb_staging') {
  throw new Error('Safety stop: DATABASE_URL must point to dashdb_staging');
}

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.$transaction(async (tx) => {
    const lagos = await tx.city.findUnique({ where: { slug: 'lagos' } });
    if (!lagos) throw new Error('Seeded Lagos city was not found');

    const sourceOwner = await tx.vendorUser.findFirst({
      where: { vendor: { slug: 'iya-kemi-kitchen' }, role: 'vendor_owner' },
      select: { identity: { select: { passwordHash: true } } },
    });
    if (!sourceOwner?.identity.passwordHash) {
      throw new Error('Could not reuse the existing staging vendor password');
    }

    const asaba = await tx.city.upsert({
      where: { slug: 'asaba' },
      create: {
        slug: 'asaba',
        name: 'Asaba',
        country: 'NG',
        currency: 'NGN',
        timezone: 'Africa/Lagos',
        detourFactor: 1.4,
        centreLatitude: 6.2059,
        centreLongitude: 6.6959,
        isLive: true,
      },
      update: { isLive: true },
    });

    const centre = { latitude: 6.2059, longitude: 6.6959 };
    const radiusKm = 15;
    const ring = Array.from({ length: 64 }, (_, index) => {
      const angle = (2 * Math.PI * index) / 64;
      const latitude = centre.latitude + (radiusKm / 111.32) * Math.sin(angle);
      const longitude =
        centre.longitude +
        (radiusKm / (111.32 * Math.cos((centre.latitude * Math.PI) / 180))) * Math.cos(angle);
      return [Number(longitude.toFixed(6)), Number(latitude.toFixed(6))];
    });
    const latitudes = ring.map((point) => point[1]);
    const longitudes = ring.map((point) => point[0]);

    const asabaZone = await tx.zone.upsert({
      where: { cityId_slug: { cityId: asaba.id, slug: 'asaba-central-staging' } },
      create: {
        cityId: asaba.id,
        slug: 'asaba-central-staging',
        name: 'Asaba Central — Staging',
        polygon: JSON.stringify(ring),
        minLatitude: Math.min(...latitudes),
        maxLatitude: Math.max(...latitudes),
        minLongitude: Math.min(...longitudes),
        maxLongitude: Math.max(...longitudes),
        isActive: true,
      },
      update: {
        polygon: JSON.stringify(ring),
        minLatitude: Math.min(...latitudes),
        maxLatitude: Math.max(...latitudes),
        minLongitude: Math.min(...longitudes),
        maxLongitude: Math.max(...longitudes),
        isActive: true,
      },
    });

    const existingPricing = await tx.pricingRule.findFirst({
      where: { cityId: asaba.id },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!existingPricing) {
      const sourcePricing = await tx.pricingRule.findFirst({
        where: { cityId: lagos.id },
        orderBy: { effectiveFrom: 'desc' },
      });
      if (!sourcePricing) throw new Error('Seeded Lagos pricing was not found');
      await tx.pricingRule.create({
        data: {
          cityId: asaba.id,
          version: 'asaba-staging-2026.09.1',
          baseDeliveryFee: sourcePricing.baseDeliveryFee,
          includedMetres: sourcePricing.includedMetres,
          perKilometreFee: sourcePricing.perKilometreFee,
          perMinuteFee: sourcePricing.perMinuteFee,
          minimumDeliveryFee: sourcePricing.minimumDeliveryFee,
          maximumDeliveryFee: sourcePricing.maximumDeliveryFee,
          serviceFeeBasisPoints: sourcePricing.serviceFeeBasisPoints,
          serviceFeeCap: sourcePricing.serviceFeeCap,
          smallOrderThreshold: sourcePricing.smallOrderThreshold,
          smallOrderFee: sourcePricing.smallOrderFee,
          taxBasisPoints: sourcePricing.taxBasisPoints,
          maximumSurgeMultiplier: sourcePricing.maximumSurgeMultiplier,
        },
      });
    }

    const vendor = await tx.vendor.upsert({
      where: { slug: 'dash-asaba-test-store' },
      create: {
        cityId: asaba.id,
        name: 'DASH Asaba Test Store — DEMO',
        slug: 'dash-asaba-test-store',
        description: 'Staging-only vendor for testing the Asaba delivery flow.',
        category: 'restaurant',
        status: 'approved',
        approvedAt: new Date(),
        commissionBasisPoints: 0,
        ratingAverage: 5,
        ratingCount: 1,
      },
      update: { cityId: asaba.id, status: 'approved' },
    });

    let branch = await tx.branch.findFirst({
      where: { vendorId: vendor.id, name: 'Asaba Demo Branch' },
    });
    const branchData = {
      zoneId: asabaZone.id,
      address: 'Asaba demo pickup — staging only',
      phone: '+2347000000199',
      latitude: 6.2059,
      longitude: 6.6959,
      deliveryRadiusMetres: 5000,
      state: 'open',
      supportsDelivery: true,
      supportsPickup: true,
      minimumOrder: 0,
      defaultPrepMinutes: 5,
      isActive: true,
    };
    branch = branch
      ? await tx.branch.update({ where: { id: branch.id }, data: branchData })
      : await tx.branch.create({
          data: { vendorId: vendor.id, name: 'Asaba Demo Branch', ...branchData },
        });

    await tx.operatingHour.deleteMany({ where: { branchId: branch.id } });
    await tx.operatingHour.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        branchId: branch.id,
        dayOfWeek,
        opensAtMinute: 0,
        closesAtMinute: 1440,
      })),
    });

    const demoOwnerEmail = 'asaba-demo@dashworldng.com';
    const legacyDemoOwnerEmail = 'asaba-demo@dashapp.test';
    const existingDemoOwner = await tx.identity.findUnique({
      where: { email: demoOwnerEmail },
    });
    const legacyDemoOwner = existingDemoOwner
      ? null
      : await tx.identity.findUnique({ where: { email: legacyDemoOwnerEmail } });

    const demoOwner = existingDemoOwner
      ? await tx.identity.update({
          where: { id: existingDemoOwner.id },
          data: {
            displayName: 'Asaba Demo Vendor Owner',
            passwordHash: sourceOwner.identity.passwordHash,
          },
        })
      : legacyDemoOwner
        ? await tx.identity.update({
            where: { id: legacyDemoOwner.id },
            data: {
              email: demoOwnerEmail,
              displayName: 'Asaba Demo Vendor Owner',
              passwordHash: sourceOwner.identity.passwordHash,
            },
          })
        : await tx.identity.create({
            data: {
              email: demoOwnerEmail,
              displayName: 'Asaba Demo Vendor Owner',
              passwordHash: sourceOwner.identity.passwordHash,
            },
          });

    const ownerRole = await tx.identityRole.findFirst({
      where: { identityId: demoOwner.id, role: 'vendor_owner', vendorId: vendor.id },
    });
    if (!ownerRole) {
      await tx.identityRole.create({
        data: { identityId: demoOwner.id, role: 'vendor_owner', vendorId: vendor.id },
      });
    }
    await tx.vendorUser.upsert({
      where: { vendorId_identityId: { vendorId: vendor.id, identityId: demoOwner.id } },
      create: {
        vendorId: vendor.id,
        identityId: demoOwner.id,
        role: 'vendor_owner',
        acceptedAt: new Date(),
      },
      update: { role: 'vendor_owner', revokedAt: null },
    });

    let category = await tx.menuCategory.findFirst({
      where: { vendorId: vendor.id, name: 'Demo Items' },
    });
    if (!category) {
      category = await tx.menuCategory.create({
        data: { vendorId: vendor.id, name: 'Demo Items', sortOrder: 0, isActive: true },
      });
    }

    let item = await tx.menuItem.findFirst({
      where: { vendorId: vendor.id, name: 'Staging Test Order' },
    });
    item = item
      ? await tx.menuItem.update({
          where: { id: item.id },
          data: { categoryId: category.id, price: 100000, isAvailable: true, archivedAt: null },
        })
      : await tx.menuItem.create({
          data: {
            vendorId: vendor.id,
            categoryId: category.id,
            name: 'Staging Test Order',
            description: 'Demo item. No real food or payment is involved.',
            price: 100000,
            prepMinutes: 5,
            isAvailable: true,
          },
        });
    await tx.itemStock.upsert({
      where: { itemId_branchId: { itemId: item.id, branchId: branch.id } },
      create: { itemId: item.id, branchId: branch.id, quantity: null, isAvailable: true },
      update: { quantity: null, isAvailable: true },
    });

    const customerIdentity = await tx.identity.findUnique({
      where: { phone: '+2347000000201' },
      select: { phone: true, customer: { select: { id: true } } },
    });
    if (!customerIdentity?.customer) throw new Error('Seeded customer 201 was not found');
    await tx.address.updateMany({
      where: { customerId: customerIdentity.customer.id },
      data: { isDefault: false },
    });
    const existingAddress = await tx.address.findFirst({
      where: { customerId: customerIdentity.customer.id, label: 'Asaba Demo' },
    });
    const addressData = {
      line1: 'Asaba demo drop-off — staging only',
      contactPhone: customerIdentity.phone ?? '+2347000000201',
      latitude: 6.2145,
      longitude: 6.7045,
      isDefault: true,
      archivedAt: null,
    };
    const address = existingAddress
      ? await tx.address.update({ where: { id: existingAddress.id }, data: addressData })
      : await tx.address.create({
          data: {
            customerId: customerIdentity.customer.id,
            label: 'Asaba Demo',
            ...addressData,
          },
        });

    const riderIdentity = await tx.identity.findUnique({
      where: { phone: '+2347000000301' },
      select: { rider: { select: { id: true } } },
    });
    if (!riderIdentity?.rider) throw new Error('Seeded rider 301 was not found');
    const permittedZones = await tx.zone.findMany({
      where: { cityId: { in: [lagos.id, asaba.id] }, isActive: true },
      select: { id: true },
    });
    await tx.rider.update({
      where: { id: riderIdentity.rider.id },
      data: { allowedZoneIds: JSON.stringify(permittedZones.map((zone) => zone.id)) },
    });

    return {
      city: asaba.name,
      zone: asabaZone.name,
      vendor: vendor.name,
      vendorLogin: demoOwner.email,
      customer: '...201',
      rider: '...301',
      branchDeliveryRadius: `${branch.deliveryRadiusMetres / 1000} km`,
      demoAddress: address.label,
    };
  }, { maxWait: 10000, timeout: 30000 });

  console.dir(result, { depth: null });
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
