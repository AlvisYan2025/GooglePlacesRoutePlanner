# ZIP → Places → Best Route (Google Maps)

Simple app that:

1. **Converts a ZIP code to lat/lng** (Google Geocoding API)
2. **Searches places by category keywords** near that ZIP (Google Places Nearby Search)
3. **Generates an optimized route link** (Google Directions API + Google Maps link)

## Setup

### 1) Install deps

```bash
npm install
```

### 2) Add your API key

Create `server/.env`:

```bash
GOOGLE_API_KEY=YOUR_KEY_HERE
PORT=8787
```

Enable these APIs in Google Cloud Console:
- **Geocoding API**
- **Places API**
- **Directions API**

### 3) Run dev

```bash
npm run dev
```

Open:
- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8787/api/health`

## Notes / limits

- **Waypoint limit**: route generation is limited to **23 places** to stay within common Directions waypoint limits.
- **Search behavior**: categories are treated as **keyword** searches (e.g. "coffee", "tacos", "gym").

