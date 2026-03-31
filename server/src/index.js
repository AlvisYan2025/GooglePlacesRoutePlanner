import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { z } from 'zod';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
if (!GOOGLE_API_KEY) {
  console.warn(
    '[server] Missing GOOGLE_API_KEY. Create server/.env with GOOGLE_API_KEY=...'
  );
}

function requireKey() {
  if (!GOOGLE_API_KEY) {
    const err = new Error('Server missing GOOGLE_API_KEY');
    err.status = 500;
    throw err;
  }
  return GOOGLE_API_KEY;
}

async function googleGetJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Google request failed: ${res.status} ${text}`);
    err.status = 502;
    throw err;
  }
  return await res.json();
}

function assertGoogleOk(payload) {
  // Google APIs often return { status: "OK"|"ZERO_RESULTS"|... , error_message? }
  if (payload?.status && payload.status !== 'OK' && payload.status !== 'ZERO_RESULTS') {
    const err = new Error(payload.error_message || `Google status: ${payload.status}`);
    err.status = 502;
    throw err;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

// 1) ZIP -> lat/lng using Geocoding API
app.get('/api/geocode', async (req, res, next) => {
  try {
    const schema = z.object({
      zip: z.string().min(3),
      country: z.string().min(2).optional().default('US')
    });
    const { zip, country } = schema.parse(req.query);

    const key = requireKey();
    const address = encodeURIComponent(`${zip}, ${country}`);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${address}&key=${encodeURIComponent(
      key
    )}`;
    const data = await googleGetJson(url);
    assertGoogleOk(data);

    const first = data.results?.[0];
    if (!first) {
      return res.status(404).json({ error: 'No geocode results for that ZIP' });
    }
    const loc = first.geometry?.location;
    res.json({
      zip,
      country,
      formatted_address: first.formatted_address,
      location: { lat: loc.lat, lng: loc.lng }
    });
  } catch (e) {
    next(e);
  }
});

// 2) Categories -> nearby places near ZIP lat/lng using Places Nearby Search
app.post('/api/places', async (req, res, next) => {
  try {
    const schema = z.object({
      zip: z.string().min(3),
      country: z.string().min(2).optional().default('US'),
      categories: z.array(z.string().min(1)).min(1),
      radiusMeters: z.number().int().min(500).max(50000).optional().default(5000),
      perCategoryLimit: z.number().int().min(1).max(20).optional().default(10)
    });
    const { zip, country, categories, radiusMeters, perCategoryLimit } = schema.parse(req.body);

    const key = requireKey();

    // geocode first
    const address = encodeURIComponent(`${zip}, ${country}`);
    const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${address}&key=${encodeURIComponent(
      key
    )}`;
    const geo = await googleGetJson(geoUrl);
    assertGoogleOk(geo);
    const first = geo.results?.[0];
    if (!first) return res.status(404).json({ error: 'No geocode results for that ZIP' });
    const loc = first.geometry?.location;
    const locationStr = `${loc.lat},${loc.lng}`;

    const resultsByCategory = {};
    const dedupe = new Map(); // place_id -> place

    for (const rawCat of categories) {
      const cat = rawCat.trim();
      if (!cat) continue;
      const keyword = encodeURIComponent(cat);
      const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${encodeURIComponent(
        locationStr
      )}&radius=${encodeURIComponent(String(radiusMeters))}&keyword=${keyword}&key=${encodeURIComponent(key)}`;

      const data = await googleGetJson(url);
      assertGoogleOk(data);
      const places = (data.results || []).slice(0, perCategoryLimit).map((p) => ({
        place_id: p.place_id,
        name: p.name,
        vicinity: p.vicinity,
        rating: p.rating,
        user_ratings_total: p.user_ratings_total,
        types: p.types,
        location: {
          lat: p.geometry?.location?.lat,
          lng: p.geometry?.location?.lng
        },
        maps_url: p.place_id
          ? `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(
              p.place_id
            )}`
          : null
      }));

      resultsByCategory[cat] = places;
      for (const pl of places) {
        if (pl.place_id && !dedupe.has(pl.place_id)) dedupe.set(pl.place_id, pl);
      }
    }

    res.json({
      zip,
      country,
      center: { lat: loc.lat, lng: loc.lng },
      formatted_address: first.formatted_address,
      resultsByCategory,
      uniquePlaces: Array.from(dedupe.values())
    });
  } catch (e) {
    next(e);
  }
});

// 3) Optimize route order via Directions API
app.post('/api/route', async (req, res, next) => {
  try {
    const schema = z.object({
      origin: z.object({ lat: z.number(), lng: z.number() }),
      placeIds: z.array(z.string().min(1)).min(1).max(23), // Directions supports up to 23 waypoints (paid tiers vary)
      returnToStart: z.boolean().optional().default(false)
    });
    const { origin, placeIds, returnToStart } = schema.parse(req.body);
    const key = requireKey();

    const originStr = `${origin.lat},${origin.lng}`;
    const waypoints = placeIds.map((id) => `place_id:${id}`).join('|');
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(
      originStr
    )}&destination=${encodeURIComponent(originStr)}&waypoints=${encodeURIComponent(
      `optimize:true|${waypoints}`
    )}&key=${encodeURIComponent(key)}`;

    const data = await googleGetJson(url);
    assertGoogleOk(data);

    const route = data.routes?.[0];
    if (!route) return res.status(404).json({ error: 'No route found' });

    const order = route.waypoint_order || [];
    const orderedPlaceIds = order.map((i) => placeIds[i]);

    // Build a Google Maps link using lat/lng from Directions legs (more reliable than requiring extra Place Details)
    // legs (in this request): origin -> stop1 -> stop2 -> ... -> origin (return)
    const legs = route.legs || [];
    const orderedStopsLatLng = legs
      .slice(0, -1) // exclude final return-to-origin leg end
      .map((leg) => leg.end_location)
      .filter(Boolean)
      .map((p) => `${p.lat},${p.lng}`);

    let mapsLink = null;
    if (returnToStart) {
      mapsLink =
        `https://www.google.com/maps/dir/?api=1` +
        `&origin=${encodeURIComponent(originStr)}` +
        `&destination=${encodeURIComponent(originStr)}` +
        (orderedStopsLatLng.length
          ? `&waypoints=${encodeURIComponent(orderedStopsLatLng.join('|'))}`
          : '') +
        `&travelmode=driving`;
    } else {
      const destination = orderedStopsLatLng[orderedStopsLatLng.length - 1] || originStr;
      const waypointsNoReturn = orderedStopsLatLng.slice(0, -1);
      mapsLink =
        `https://www.google.com/maps/dir/?api=1` +
        `&origin=${encodeURIComponent(originStr)}` +
        `&destination=${encodeURIComponent(destination)}` +
        (waypointsNoReturn.length ? `&waypoints=${encodeURIComponent(waypointsNoReturn.join('|'))}` : '') +
        `&travelmode=driving`;
    }

    res.json({
      origin,
      orderedPlaceIds,
      mapsLink,
      returnToStart,
      summary: route.summary,
      warnings: route.warnings || []
    });
  } catch (e) {
    next(e);
  }
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Unknown error',
    status
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

