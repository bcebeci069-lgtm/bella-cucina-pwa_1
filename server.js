// ═══════════════════════════════════════════════════════════
// Restaurant App — Backend Server
// Uber Direct + Wolt Drive Integration
//
// Setup:
//   npm install express cors node-fetch dotenv
//   node server.js
// ═══════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const app     = express();

app.use(cors());
app.use(express.json());

// ───────────────────────────────────────────────
// KONFIGURATION (.env Datei anlegen!)
// ───────────────────────────────────────────────
const CONFIG = {
  uber: {
    clientId:     process.env.UBER_CLIENT_ID,
    clientSecret: process.env.UBER_CLIENT_SECRET,
    customerId:   process.env.UBER_CUSTOMER_ID,
    // Restaurant Koordinaten (Google Maps → Rechtsklick → Koordinaten kopieren)
    pickupLat:    48.7758,
    pickupLng:    9.1829,
    pickupAddress: 'Restaurantstraße 1, 70173 Stuttgart',
    pickupPhone:  '+4971112345678',
    pickupName:   'Bella Cucina',
  },
  wolt: {
    apiKey:     process.env.WOLT_API_KEY,
    merchantId: process.env.WOLT_MERCHANT_ID,
    venueId:    process.env.WOLT_VENUE_ID,
  }
};

// ───────────────────────────────────────────────
// UBER DIRECT — OAuth2 Token holen
// Wird automatisch gecacht und erneuert
// ───────────────────────────────────────────────
let uberTokenCache = { token: null, expiresAt: 0 };

async function getUberToken() {
  // Noch gültig? Cache nutzen
  if (uberTokenCache.token && Date.now() < uberTokenCache.expiresAt) {
    return uberTokenCache.token;
  }

  const res = await fetch('https://auth.uber.com/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CONFIG.uber.clientId,
      client_secret: CONFIG.uber.clientSecret,
      grant_type:    'client_credentials',
      scope:         'eats.deliveries',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Uber Auth fehlgeschlagen: ${err}`);
  }

  const data = await res.json();
  uberTokenCache = {
    token:     data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000, // 1 Min Puffer
  };

  console.log('✅ Uber Token erhalten, gültig bis:', new Date(uberTokenCache.expiresAt).toLocaleTimeString());
  return uberTokenCache.token;
}

// ───────────────────────────────────────────────
// ROUTE: Bestellung aufgeben
// POST /api/order
// Body: { customer, address, phone, items, deliveryService }
// ───────────────────────────────────────────────
app.post('/api/order', async (req, res) => {
  const { customer, address, phone, items, deliveryService } = req.body;

  // Validierung
  if (!customer || !address || !phone || !items?.length) {
    return res.status(400).json({ error: 'Fehlende Felder: customer, address, phone, items' });
  }

  const orderId = 'BC-' + Date.now();

  try {
    let deliveryResult;

    if (deliveryService === 'uber') {
      deliveryResult = await createUberDelivery({ orderId, customer, address, phone, items });
    } else if (deliveryService === 'wolt') {
      deliveryResult = await createWoltDelivery({ orderId, customer, address, phone, items });
    } else {
      return res.status(400).json({ error: 'deliveryService muss "uber" oder "wolt" sein' });
    }

    res.json({
      success:    true,
      orderId:    '#' + orderId,
      delivery:   deliveryResult,
      message:    'Bestellung erfolgreich! Fahrer wird zugewiesen.',
    });

  } catch (err) {
    console.error('❌ Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────
// UBER DIRECT — Lieferung erstellen
// Docs: https://developer.uber.com/docs/deliveries/reference/v1
// ───────────────────────────────────────────────
async function createUberDelivery({ orderId, customer, address, phone, items }) {
  const token = await getUberToken();

  // Adresse als Uber-Format aufbereiten
  // Für Produktion: Google Maps Geocoding API nutzen um Koordinaten zu bekommen
  const dropoffAddress = {
    street_address: [address],
    city:           'Stuttgart',
    state:          'BW',
    zip_code:       '70173',
    country:        'DE',
  };

  const payload = {
    // Abholung beim Restaurant
    pickup_name:         CONFIG.uber.pickupName,
    pickup_address:      JSON.stringify({
      street_address: [CONFIG.uber.pickupAddress],
      city: 'Stuttgart', state: 'BW', zip_code: '70173', country: 'DE'
    }),
    pickup_phone_number: CONFIG.uber.pickupPhone,
    pickup_latitude:     CONFIG.uber.pickupLat,
    pickup_longitude:    CONFIG.uber.pickupLng,

    // Lieferung zum Kunden
    dropoff_name:        customer,
    dropoff_address:     JSON.stringify(dropoffAddress),
    dropoff_phone_number: phone,

    // Bestelldetails
    manifest_items: items.map(item => ({
      name:       item.name,
      quantity:   item.qty,
      size:       'small',
      price:      Math.round(item.price * 100), // in Cent
      dimensions: { length: 20, height: 10, depth: 20, weight: 500 },
    })),

    external_id:       orderId,        // Ihre interne Bestellnummer
    pickup_ready_dt:   new Date(Date.now() + 15 * 60000).toISOString(), // bereit in 15 Min
    dropoff_ready_dt:  new Date(Date.now() + 30 * 60000).toISOString(),
  };

  const res = await fetch(
    `https://api.uber.com/v1/customers/${CONFIG.uber.customerId}/deliveries`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Uber Direct Fehler: ${JSON.stringify(data)}`);
  }

  console.log('🚗 Uber Direct Lieferung erstellt:', data.id);
  return {
    service:     'Uber Direct',
    deliveryId:  data.id,
    trackingUrl: data.tracking_url,
    status:      data.status,
    fee:         data.fee ? `€${(data.fee / 100).toFixed(2)}` : null,
  };
}

// ───────────────────────────────────────────────
// WOLT DRIVE — Lieferung erstellen
// Docs: https://developer.wolt.com/docs/drive
// ───────────────────────────────────────────────
async function createWoltDelivery({ orderId, customer, address, phone, items }) {
  const totalCents = items.reduce((sum, i) => sum + Math.round(i.price * i.qty * 100), 0);

  const payload = {
    merchant_id:        CONFIG.wolt.merchantId,
    merchant_reference: orderId,

    pickup: {
      location: {
        type: 'Feature',
        geometry: {
          type:        'Point',
          coordinates: [CONFIG.uber.pickupLng, CONFIG.uber.pickupLat], // [lng, lat]!
        },
        properties: {
          city:              'Stuttgart',
          country:           'DEU',
          formatted_address: CONFIG.uber.pickupAddress,
          street_address:    CONFIG.uber.pickupAddress,
        },
      },
      comment: `Bestellung ${orderId} — bereit in 15 Min`,
    },

    dropoff: {
      location: {
        type: 'Feature',
        geometry: {
          type:        'Point',
          coordinates: [9.19, 48.78], // Für Produktion: Geocoding nutzen!
        },
        properties: {
          city:              'Stuttgart',
          country:           'DEU',
          formatted_address: address,
          street_address:    address,
        },
      },
      contact_details: {
        name:         customer,
        phone_number: phone,
      },
    },

    items: items.map(item => ({
      count:       item.qty,
      description: item.name,
      price: {
        currency: 'EUR',
        amount:   Math.round(item.price * 100),
      },
    })),

    // Gesamtbestellwert (für Wolt interne Abrechnung)
    price: {
      currency: 'EUR',
      amount:   totalCents,
    },
  };

  const res = await fetch('https://daas-public-api.wolt.com/v1/orders', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${CONFIG.wolt.apiKey}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Wolt Drive Fehler: ${JSON.stringify(data)}`);
  }

  console.log('🛵 Wolt Drive Lieferung erstellt:', data.id);
  return {
    service:    'Wolt Drive',
    orderId:    data.id,
    status:     data.status,
    trackingUrl: data.tracking?.public_tracking_url,
  };
}

// ───────────────────────────────────────────────
// ROUTE: Lieferstatus abfragen
// GET /api/order/:orderId/status?service=uber|wolt
// ───────────────────────────────────────────────
app.get('/api/order/:deliveryId/status', async (req, res) => {
  const { deliveryId } = req.params;
  const { service }    = req.query;

  try {
    if (service === 'uber') {
      const token = await getUberToken();
      const r = await fetch(
        `https://api.uber.com/v1/customers/${CONFIG.uber.customerId}/deliveries/${deliveryId}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      const data = await r.json();
      res.json({ status: data.status, tracking_url: data.tracking_url, courier: data.courier });

    } else if (service === 'wolt') {
      const r = await fetch(`https://daas-public-api.wolt.com/v1/orders/${deliveryId}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.wolt.apiKey}` }
      });
      const data = await r.json();
      res.json({ status: data.status, tracking_url: data.tracking?.public_tracking_url });

    } else {
      res.status(400).json({ error: 'service Parameter fehlt (uber oder wolt)' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────
// SERVER STARTEN
// ───────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🍽  Restaurant Backend läuft auf http://localhost:${PORT}`);
  console.log(`📡  Uber Direct: ${CONFIG.uber.clientId ? '✅ Konfiguriert' : '❌ Fehlt (UBER_CLIENT_ID in .env)'}`);
  console.log(`📡  Wolt Drive:  ${CONFIG.wolt.apiKey   ? '✅ Konfiguriert' : '❌ Fehlt (WOLT_API_KEY in .env)'}\n`);
});
