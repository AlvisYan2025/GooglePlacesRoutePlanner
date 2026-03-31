import { useMemo, useState } from 'react';

type LatLng = { lat: number; lng: number };

type Place = {
  place_id: string;
  name: string;
  vicinity?: string;
  rating?: number;
  user_ratings_total?: number;
  types?: string[];
  location: LatLng;
  maps_url?: string | null;
};

type PlacesResponse = {
  zip: string;
  country: string;
  center: LatLng;
  formatted_address: string;
  resultsByCategory: Record<string, Place[]>;
  uniquePlaces: Place[];
};

function normalizeCategory(s: string) {
  return s.trim().replace(/\s+/g, ' ');
}

function uniqCaseInsensitive(list: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function App() {
  const [zip, setZip] = useState('');
  const country = 'US';
  const [categoryDraft, setCategoryDraft] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const [radiusMeters, setRadiusMeters] = useState(5000);
  const [perCategoryLimit, setPerCategoryLimit] = useState(8);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [places, setPlaces] = useState<PlacesResponse | null>(null);
  const [removedPlaceIds, setRemovedPlaceIds] = useState<Set<string>>(new Set());
  const [routeLink, setRouteLink] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);

  const normalizedCategories = useMemo(
    () => uniqCaseInsensitive(categories.map(normalizeCategory).filter(Boolean)),
    [categories]
  );

  const presets = useMemo(
    () => ['coffee shop', 'barbershop', 'salon', 'law firms', 'restaurants'],
    []
  );

  function addCategoryValue(value: string) {
    const next = normalizeCategory(value);
    if (!next) return;
    setCategories((prev) => uniqCaseInsensitive([...prev, next].map(normalizeCategory).filter(Boolean)));
  }

  function addCategory() {
    const next = normalizeCategory(categoryDraft);
    if (!next) return;
    addCategoryValue(next);
    setCategoryDraft('');
  }

  function removeCategory(cat: string) {
    setCategories((prev) => prev.filter((c) => c.toLowerCase() !== cat.toLowerCase()));
  }

  function removePlace(placeId: string) {
    setRemovedPlaceIds((prev) => {
      const next = new Set(prev);
      next.add(placeId);
      return next;
    });
  }

  function isPlaceRemoved(placeId: string) {
    return removedPlaceIds.has(placeId);
  }

  async function onSearch() {
    setError(null);
    setRouteLink(null);
    setPlaces(null);
    setRemovedPlaceIds(new Set());
    setLoading(true);
    try {
      const resp = await fetch('/api/places', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zip: zip.trim(),
          country,
          categories: normalizedCategories,
          radiusMeters,
          perCategoryLimit
        })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Failed to fetch places');
      setPlaces(data);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  async function onBuildRoute() {
    if (!places) return;
    setError(null);
    setRouteLink(null);
    setRouteLoading(true);
    try {
      // Keep it simple: limit to 23 stops due to Directions waypoint limits
      const placeIds = places.uniquePlaces
        .map((p) => p.place_id)
        .filter(Boolean)
        .filter((id) => !isPlaceRemoved(id))
        .slice(0, 23);
      if (placeIds.length === 0) throw new Error('No places to route');

      const resp = await fetch('/api/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: places.center,
          placeIds
        })
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.error || 'Failed to build route');
      setRouteLink(data.mapsLink);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRouteLoading(false);
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <div className="title">Google Places Route Planner</div>
        </div>
      </header>

      <section className="card">
        <div className="grid">
          <label className="field">
            <div className="label">ZIP code</div>
            <input value={zip} onChange={(e) => setZip(e.target.value)} placeholder="e.g. 94103" />
          </label>

          <div className="field">
            <div className="label">Country</div>
            <div className="readonlyValue">{country}</div>
          </div>

          <label className="field">
            <div className="label">Radius (meters)</div>
            <input
              type="number"
              min={500}
              max={50000}
              step={100}
              value={radiusMeters}
              onChange={(e) => setRadiusMeters(Number(e.target.value))}
            />
          </label>

          <label className="field">
            <div className="label">Max results per category</div>
            <input
              type="number"
              min={1}
              max={20}
              value={perCategoryLimit}
              onChange={(e) => setPerCategoryLimit(Number(e.target.value))}
            />
          </label>

          <div className="field field-span">
            <div className="label">Categories</div>
            <div className="row">
              <input
                value={categoryDraft}
                onChange={(e) => setCategoryDraft(e.target.value)}
                placeholder="Type a category (e.g. coffee)"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCategory();
                  }
                }}
              />
              <button className="btn" type="button" onClick={addCategory} disabled={!normalizeCategory(categoryDraft)}>
                Add category
              </button>
            </div>
            <div className="chips" aria-label="Suggested categories">
              {presets.map((p) => {
                const exists = normalizedCategories.some((c) => c.toLowerCase() === p.toLowerCase());
                return (
                  <button
                    key={p}
                    type="button"
                    className="btn btnTiny"
                    onClick={() => addCategoryValue(p)}
                    disabled={exists}
                    title={exists ? 'Already added' : `Add “${p}”`}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
            <div className="chips" aria-label="Added categories">
              {normalizedCategories.length === 0 ? (
                <div className="muted">Add at least one category.</div>
              ) : (
                normalizedCategories.map((cat) => (
                  <span className="chip" key={cat}>
                    <span className="chipText">{cat}</span>
                    <button className="chipX" type="button" onClick={() => removeCategory(cat)} aria-label={`Remove ${cat}`}>
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
            <div className="hint">
              Added: <b>{normalizedCategories.length}</b>. (Example: “coffee”, “tacos”, “gym”)
            </div>
          </div>
        </div>

        <div className="actions">
          <button
            className="btn primary"
            onClick={onSearch}
            disabled={loading || !zip.trim() || normalizedCategories.length === 0}
          >
            {loading ? 'Searching…' : 'Search places'}
          </button>

          <button className="btn" onClick={onBuildRoute} disabled={!places || routeLoading}>
            {routeLoading ? 'Building route…' : 'Generate best route link'}
          </button>

          {routeLink && (
            <a className="btn link" href={routeLink} target="_blank" rel="noreferrer">
              Open route in Google Maps
            </a>
          )}
        </div>

        {error && <div className="error">{error}</div>}
      </section>

      {places && (
        <section className="card">
          <div className="sectionHeader">
            <div>
              <div className="sectionTitle">Results</div>
              <div className="sectionSub">
                Center: {places.formatted_address} ({places.center.lat.toFixed(5)},{' '}
                {places.center.lng.toFixed(5)}) • Showing: <b>{places.uniquePlaces.length - removedPlaceIds.size}</b> /{' '}
                <b>{places.uniquePlaces.length}</b>
              </div>
            </div>
          </div>

          <div className="columns">
            {Object.entries(places.resultsByCategory).map(([cat, list]) => (
              <div className="col" key={cat}>
                <div className="colTitle">{cat}</div>
                {list.filter((p) => !isPlaceRemoved(p.place_id)).length === 0 ? (
                  <div className="muted">No results.</div>
                ) : (
                  <ul className="list">
                    {list
                      .filter((p) => !isPlaceRemoved(p.place_id))
                      .map((p) => (
                        <li className="item" key={p.place_id}>
                        <div className="itemMain">
                          <div className="itemName">{p.name}</div>
                          <div className="itemMeta">
                            {p.vicinity ? <span>{p.vicinity}</span> : null}
                            {typeof p.rating === 'number' ? (
                              <span>
                                Rating: <b>{p.rating}</b>
                                {typeof p.user_ratings_total === 'number' ? (
                                  <span className="muted"> ({p.user_ratings_total})</span>
                                ) : null}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="itemActions">
                          <button
                            className="iconBtn"
                            type="button"
                            onClick={() => removePlace(p.place_id)}
                            aria-label={`Remove ${p.name}`}
                            title="Remove from results/route"
                          >
                            ×
                          </button>
                        </div>
                      </li>
                      ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}

