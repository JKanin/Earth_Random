// Реестр режимов отдельных стран. Каждый режим — отдельный файл в папке modes/ (см. modes/russia.js).
const MODES = {};

// Источники данных (все открытые, с поддержкой CORS):
//  - jsDelivr (mledoze/countries): список стран
//  - Overpass (несколько зеркал параллельно): регионы и города
//  - Nominatim (OpenStreetMap): контуры границ
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
const NOM = "https://nominatim.openstreetmap.org";

// Запрос к Overpass: берём ответ первого зеркала, которое справилось. null = все недоступны.
async function ovp(query) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    return await Promise.any(MIRRORS.map(async url => {
      const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), signal: ctrl.signal });
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json();
      if (!j.elements || (j.remark && !j.elements.length)) throw new Error("overpass: " + (j.remark || "пусто"));
      return j.elements;
    }));
  } catch (e) {
    console.warn("Overpass недоступен:", e);
    return null;
  } finally { clearTimeout(timer); ctrl.abort(); }
}

async function nominatim(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    return await r.json();
  } catch (e) { console.warn("Nominatim:", e); return []; }
}

// Круг вокруг точки (запасной вариант, если у города нет контура)
function circle([lng, lat], km = 2.5) {
  const pts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    pts.push([lng + (km / (111.32 * Math.cos(lat * Math.PI / 180))) * Math.cos(a), lat + (km / 110.57) * Math.sin(a)]);
  }
  return { type: "Polygon", coordinates: [pts] };
}

// Запрос к Wikidata SPARQL (поддерживает CORS). null = ошибка сети.
async function sparql(q) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch("https://query.wikidata.org/sparql?format=json&query=" + encodeURIComponent(q), { signal: ctrl.signal });
    if (!r.ok) throw new Error("http " + r.status);
    return (await r.json()).results.bindings;
  } catch (e) { console.warn("Wikidata недоступен:", e); return null; }
  finally { clearTimeout(timer); }
}
const point = s => { const m = /Point\(([-\d.eE+]+) ([-\d.eE+]+)\)/.exec(s || ""); return m ? [+m[1], +m[2]] : null; };
const LABELS = 'SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,en". }';
function fromBindings(rows, key) {
  const seen = new Set(), out = [];
  for (const b of rows) {
    const name = b[key + "Label"] && b[key + "Label"].value, center = point(b.coord && b.coord.value);
    const qid = b[key].value.split("/").pop();
    if (!name || /^Q\d+$/.test(name) || !center || seen.has(qid)) continue;
    seen.add(qid);
    out.push({ qid, name, center, osm: b.osm ? +b.osm.value : null });
  }
  return out;
}

// ---- Геометрия
const polys = g => g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
const ringBox = ring => ring.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
  [Infinity, Infinity, -Infinity, -Infinity]);
const allBox = g => polys(g).map(p => ringBox(p[0])).reduce((a, b) =>
  [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
// рамка самой крупной части (чтобы заморские территории не отодвигали камеру)
const mainBox = g => polys(g).map(p => ringBox(p[0])).sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))[0];
function inRing([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
const inGeom = (pt, g) => polys(g).some(p => inRing(pt, p[0]) && !p.slice(1).some(h => inRing(pt, h)));

// Контур многоугольника в виде линий. Отрезки, «перепрыгивающие» через линию перемены дат
// (из-за них на глобусе рисуются лишние параллели) и идущие вдоль неё, отбрасываются.
function outline(g) {
  if (!g || !/Polygon/.test(g.type)) return g;
  const lines = [];
  for (const p of polys(g)) for (const ring of p) {
    let cur = [];
    ring.forEach((pt, i) => {
      if (i > 0) {
        const q = ring[i - 1];
        if (Math.abs(pt[0] - q[0]) > 180 || (Math.abs(pt[0]) >= 179.999 && Math.abs(q[0]) >= 179.999)) {
          if (cur.length > 1) lines.push(cur);
          cur = [];
        }
      }
      cur.push(pt);
    });
    if (cur.length > 1) lines.push(cur);
  }
  return { type: "MultiLineString", coordinates: lines };
}

const API = {
  _countries: null,
  _cache: {},

  async countries() {
    if (this._countries) return this._countries;
    const urls = [
      "https://cdn.jsdelivr.net/gh/mledoze/countries@master/dist/countries.json",
      "https://restcountries.com/v3.1/all?fields=name,latlng,area,translations,unMember,region,cca2"
    ];
    let data = null;
    for (const url of urls) {
      try { const r = await fetch(url); if (r.ok) { data = await r.json(); break; } } catch (e) {}
    }
    if (!data) throw new Error("countries: источник недоступен");
    this._countries = data
      .filter(c => c.latlng && c.latlng.length === 2 && c.region && c.region !== "Antarctic")
      .map(c => ({
        cca2: c.cca2,
        cca3: c.cca3,
        ccn3: c.ccn3,
        name: (c.translations.rus && c.translations.rus.common) || c.name.common,
        center: [c.latlng[1], c.latlng[0]],
        zoom: Math.min(9, Math.max(1.8, 13.1 - 0.648 * Math.log(c.area || 1000))),
        un: !!c.unMember,
        continent: c.region
      }));
    return this._countries;
  },

  // Регионы страны: {list, failed}. Сначала Wikidata, затем Overpass.
  async _regionsWD(cc) {
    if (this._cache["r" + cc]) return this._cache["r" + cc];
    const rows = await sparql(`SELECT ?r ?rLabel ?coord ?osm WHERE { ?c wdt:P297 "${cc}". ` +
      `?r wdt:P17 ?c; wdt:P31/wdt:P279* wd:Q10864048; wdt:P625 ?coord. OPTIONAL { ?r wdt:P402 ?osm. } ` +
      `FILTER NOT EXISTS { ?r wdt:P576 ?end } ${LABELS} } LIMIT 200`);
    let list = rows ? fromBindings(rows, "r") : [];
    if (list.length) { console.info("Регионы: Wikidata,", list.length); return (this._cache["r" + cc] = { list, failed: false }); }
    for (const lvl of [4, 3, 5]) {
      const els = await ovp(`[out:json][timeout:20];area["ISO3166-1"="${cc}"]->.a;` +
        `rel["boundary"="administrative"]["admin_level"="${lvl}"](area.a);out tags center 60;`);
      if (els === null) return { list: [], failed: rows === null };
      list = els.filter(e => e.center && e.tags && (e.tags["name:ru"] || e.tags.name))
        .map(e => ({ osm: e.id, name: e.tags["name:ru"] || e.tags.name, center: [e.center.lon, e.center.lat] }));
      if (list.length) { console.info("Регионы: Overpass,", list.length); break; }
    }
    return (this._cache["r" + cc] = { list, failed: false });
  },

  // Города региона: самые крупные по населению
  async _citiesWD(region) {
    const key = "c" + (region.qid || region.osm);
    if (this._cache[key]) return this._cache[key];
    let list = [];
    if (region.qid) {
      const rows = await sparql(`SELECT ?c ?cLabel ?coord ?osm WHERE { ?c wdt:P31/wdt:P279* wd:Q515; ` +
        `wdt:P131+ wd:${region.qid}; wdt:P625 ?coord. OPTIONAL { ?c wdt:P1082 ?pop. } OPTIONAL { ?c wdt:P402 ?osm. } ` +
        `FILTER NOT EXISTS { ?c wdt:P576 ?end } ${LABELS} } ORDER BY DESC(?pop) LIMIT 40`);
      list = rows ? fromBindings(rows, "c") : [];
    }
    if (!list.length && region.osm) {
      const els = await ovp(`[out:json][timeout:20];area(${3600000000 + region.osm})->.r;` +
        `node(area.r)["place"~"^(city|town)$"]["name"];out 50;`);
      if (els === null) return { list: [], failed: true };
      list = els.map(e => ({ name: e.tags["name:ru"] || e.tags.name, center: [e.lon, e.lat] }));
    }
    return (this._cache[key] = { list, failed: false });
  },

  // ---- Сухопутные границы: geoBoundaries (без морских зон). ADM0 — страна, ADM1 — регионы.
  async _gb(iso3, lvl) {
    const key = "gb" + iso3 + lvl;
    if (key in this._cache) return this._cache[key];
    const path = `wmgeolab/geoBoundaries/main/releaseData/gbOpen/${iso3}/${lvl}/geoBoundaries-${iso3}-${lvl}_simplified.geojson`;
    let fc = null;
    for (const url of [`https://media.githubusercontent.com/media/${path}`,
                       `https://github.com/${path.replace("/main/", "/raw/main/")}`]) {
      try {
        const r = await fetch(url);
        if (r.ok) { const j = await r.json(); if (j.features) { fc = j; break; } }
      } catch (e) { console.warn("geoBoundaries:", e); }
    }
    return (this._cache[key] = fc);
  },

  // Города мира (Natural Earth, с населением)
  async _places() {
    if (this._cache.places) return this._cache.places;
    try {
      const r = await fetch("https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_10m_populated_places_simple.geojson");
      const j = await r.json();
      return (this._cache.places = j.features.map(f => ({ name: f.properties.name, pop: f.properties.pop_max || 0,
        x: f.geometry.coordinates[0], y: f.geometry.coordinates[1] })));
    } catch (e) { console.warn("Города (Natural Earth):", e); return null; }
  },

  async regions(country) {
    const fc = await this._gb(country.cca3, "ADM1");
    if (fc) {
      const list = fc.features.filter(f => f.geometry && f.properties.shapeName).map(f => {
        const bbox = mainBox(f.geometry);
        return { name: f.properties.shapeName, geometry: f.geometry, box: allBox(f.geometry), bbox,
          center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] };
      });
      if (list.length > 1) { console.info("Регионы: geoBoundaries,", list.length); return { list, failed: false }; }
    }
    return this._regionsWD(country.cca2);   // запасной вариант: Wikidata / Overpass
  },

  async cities(region) {
    if (!region.geometry) return this._citiesWD(region);
    const pl = await this._places();
    if (!pl) return { list: [], failed: true };
    const [x0, y0, x1, y1] = region.box;
    let list = pl.filter(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && inGeom([p.x, p.y], region.geometry))
      .sort((a, b) => b.pop - a.pop);
    if (!list.length) {   // в регионе нет известных городов — берём ближайший
      const [cx, cy] = region.center;
      const n = pl.map(p => ({ p, d: (p.x - cx) ** 2 + (p.y - cy) ** 2 })).sort((a, b) => a.d - b.d)[0];
      if (n && n.d < 4) list = [n.p];
    }
    console.info("Города:", list.length);
    return { list: list.map(p => ({ name: p.name, center: [p.x, p.y] })), failed: false };
  },

  // ---- Режимы стран: регионы — geoBoundaries (ADM1), города — из mode.towns() (список с названиями и регионами)
  async regionsMode(mode) {
    const key = "mode" + mode.cca2;
    if (this._cache[key]) return this._cache[key];
    const [fc, towns] = await Promise.all([this._gb(mode.cca3, "ADM1"),
      mode.towns().catch(e => { console.warn("Города режима:", e); return null; })]);
    this._cache["towns" + mode.cca2] = towns || [];
    if (!fc) return { list: [], failed: true };
    const feats = fc.features.filter(f => f.geometry && f.properties.shapeName).map(f => {
      const bbox = mainBox(f.geometry), box = allBox(f.geometry);
      const inside = (towns || []).filter(t => t.x >= box[0] && t.x <= box[2] && t.y >= box[1] && t.y <= box[3] &&
        inGeom([t.x, t.y], f.geometry));
      return { f, bbox, box, inside };
    });
    // Контуры упрощены, поэтому прибрежные города (например, на Сахалине) могут оказаться чуть за линией:
    // отдаём такой город ближайшему региону (в пределах ~0,7°)
    const taken = new Set(feats.flatMap(r => r.inside));
    for (const t of (towns || [])) {
      if (taken.has(t)) continue;
      let best = null, bd = 0.49;
      for (const r of feats) {
        if (t.x < r.box[0] - 0.7 || t.x > r.box[2] + 0.7 || t.y < r.box[1] - 0.7 || t.y > r.box[3] + 0.7) continue;
        for (const p of polys(r.f.geometry)) for (const [x, y] of p[0]) {
          const d = (x - t.x) ** 2 + (y - t.y) ** 2;
          if (d < bd) { bd = d; best = r; }
        }
      }
      if (best) best.inside.push(t);
    }
    const list = feats.map(({ f, bbox, box, inside }) => {
      const count = {};
      inside.forEach(t => count[t.region] = (count[t.region] || 0) + 1);
      const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];   // русское название — по городам внутри
      return { name: top || f.properties.shapeName, geometry: f.geometry, box, bbox, towns: inside,
        center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] };
    });
    console.info("Регионы (" + mode.cca2 + "):", list.length, "городов:", (towns || []).length);
    return (this._cache[key] = { list, failed: false });
  },

  async citiesMode(region, mode) {
    let list = region.towns || [];
    if (!list.length) {   // в регионе нет городов из базы — ближайший
      const all = this._cache["towns" + mode.cca2] || [], [cx, cy] = region.center;
      const n = all.map(t => ({ t, d: (t.x - cx) ** 2 + (t.y - cy) ** 2 })).sort((a, b) => a.d - b.d)[0];
      if (n && n.d < 25) list = [n.t];
    }
    return { list: list.map(t => ({ name: t.name, center: [t.x, t.y] })), failed: false };
  },

  // ---- Границы (GeoJSON-геометрия или null)
  // Подробные сухопутные контуры стран (Natural Earth 1:10m, пакет world-atlas)
  async _world() {
    if ("world" in this._cache) return this._cache.world;
    try {
      const r = await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-10m.json");
      if (!r.ok) throw new Error("http " + r.status);
      const t = await r.json();
      return (this._cache.world = topojson.feature(t, t.objects.countries).features);
    } catch (e) { console.warn("world-atlas:", e); return (this._cache.world = null); }
  },

  async countryBorder(c) {
    const w = await this._world();
    const wf = w && c.ccn3 && w.find(x => String(x.id).padStart(3, "0") === c.ccn3);
    if (wf && wf.geometry) return wf.geometry;
    const gb = await this._gb(c.cca3, "ADM0");
    if (gb && gb.features.length)
      return { type: "MultiPolygon", coordinates: gb.features.flatMap(f => polys(f.geometry)) };
    const a = await nominatim(`${NOM}/search?format=jsonv2&q=${encodeURIComponent(c.name)}&countrycodes=${c.cca2.toLowerCase()}` +
      `&featureType=country&polygon_geojson=1&polygon_threshold=0.02&limit=1`);
    return a[0] && a[0].geojson || null;
  },
  async _byOsm(osm, threshold) {
    if (!osm) return null;
    const a = await nominatim(`${NOM}/lookup?osm_ids=R${osm}&format=jsonv2&polygon_geojson=1&polygon_threshold=${threshold}`);
    return a[0] && a[0].geojson && /Polygon/.test(a[0].geojson.type) ? a[0].geojson : null;
  },
  async _bySearch(name, [x, y], d, threshold) {
    const a = await nominatim(`${NOM}/search?format=jsonv2&q=${encodeURIComponent(name)}` +
      `&viewbox=${x - d},${y + d},${x + d},${y - d}&bounded=1&polygon_geojson=1&polygon_threshold=${threshold}&limit=1`);
    const g = a[0] && a[0].geojson;
    return g && /Polygon/.test(g.type) ? g : null;
  },
  async regionBorder(r) {
    if (r.geometry) return r.geometry;
    return (await this._byOsm(r.osm, 0.005)) || (r.center && await this._bySearch(r.name, r.center, 4, 0.005));
  },
  async cityBorder(city, regionName) {
    return (await this._byOsm(city.osm, 0.0005)) ||
      (await this._bySearch(city.name + ", " + regionName, city.center, 0.25, 0.0005)) || circle(city.center);
  }
};
