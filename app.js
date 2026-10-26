const $ = id => document.getElementById(id);
function pickMiddle(list) {
  const n = list.length, from = Math.floor(n / 3), to = Math.max(from + 1, Math.ceil(2 * n / 3));
  return pick(list.slice(from, to));
}
const pick = a => a[Math.floor(Math.random() * a.length)];
const EARTH = { center: [15, 30], zoom: 1.5 };
const ZOOM_REGION = 7, ZOOM_CITY = 12;
const COLORS = { country: "#c9ffb0", region: "#ffe27a", city: "#7ad7ff" };

const map = new maplibregl.Map({
  container: "map",
  style: { version: 8,
    sources: { sat: { type: "raster", tileSize: 256, maxzoom: 18,
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      attribution: "Esri, Maxar, Earthstar Geographics & GIS User Community | © OpenStreetMap" } },
    layers: [{ id: "sat", type: "raster", source: "sat" }] },
  center: EARTH.center, zoom: EARTH.zoom, maxPitch: 0
});
map.on("style.load", () => map.setProjection({ type: "globe" }));

const EMPTY = { type: "FeatureCollection", features: [] };
map.on("load", () => {
  for (const [id, color] of Object.entries(COLORS)) {
    map.addSource(id, { type: "geojson", data: EMPTY });
    map.addLayer({ id: id + "-fill", type: "fill", source: id, paint: { "fill-color": color, "fill-opacity": 0.12 } });
    map.addLayer({ id: id + "-line", type: "line", source: id,
      paint: { "line-color": color, "line-width": 2.5, "line-opacity": 0.95 } });
  }
});
function setBorder(id, geometry) {
  const src = map.getSource(id);
  if (src) src.setData(geometry ? { type: "Feature", geometry, properties: {} } : EMPTY);
}
const clearBorders = (...ids) => ids.forEach(id => setBorder(id, null));

const fly = (center, zoom) => new Promise(res => {
  map.once("moveend", res);
  map.flyTo({ center, zoom, duration: 4500, essential: true });
});

function zoomFor(b) {
  const d = Math.max(b[2] - b[0], (b[3] - b[1]) * 1.3, 0.05);
  const px = Math.min(innerWidth, innerHeight * 1.4) * 0.75;
  return Math.min(9, Math.max(3, Math.log2(px / 256 * 360 / d)));
}

let timer;
function setText(text, sub = "") {
  const el = $("name"), chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  $("sub").textContent = sub;
  clearInterval(timer);
  let f = 0;
  timer = setInterval(() => {
    el.textContent = [...text].map((ch, i) =>
      ch === " " || i < f / 2 ? ch : chars[Math.floor(Math.random() * chars.length)]).join("");
    if (++f > text.length * 2) { clearInterval(timer); el.textContent = text; }
  }, 35);
}

let level = 0, busy = false, country, region;

function setBusy(v) {
  busy = v;
  $("dice").disabled = v;
  $("back").disabled = v || level === 0;
}

$("dice").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  const prev = level;
  try {
    level = (level + 1) % 4;
    if (level === 1) {
      clearBorders("country", "region", "city");
      setText("ЗАГРУЗКА…");
      const list = (await API.countries()).filter(c =>
        ($("fUn").value === "all" || c.un) && (!$("fRegion").value || c.continent === $("fRegion").value));
      if (!list.length) throw new Error("empty");
      country = pick(list);
      setText(country.name, "Страна");
      const [, geo] = await Promise.all([fly(country.center, country.zoom), API.countryBorder(country)]);
      setBorder("country", geo);
    } else if (level === 2) {
      clearBorders("region", "city");
      setText("ПОИСК РЕГИОНА…", country.name);
      const res = await API.regions(country);
      region = res.list.length ? pick(res.list) : { name: country.name, center: country.center };
      const note = res.failed ? "Сервер регионов не ответил — показан центр страны"
        : res.list.length ? `${country.name} - ${region.name}` : "У страны нет данных о регионах";
      region.sub = note;
      region.zoom = region.bbox ? zoomFor(region.bbox) : res.list.length ? ZOOM_REGION : Math.min(country.zoom + 1.5, 9);
      setText(region.name, note);
      const [, geo] = await Promise.all([fly(region.center, region.zoom), API.regionBorder(region)]);
      setBorder("region", geo);
    } else if (level === 3) {
      clearBorders("city");
      setText("ПОИСК ГОРОДА…", region.name);
      const res = (region.geometry || region.qid || region.osm) ? await API.cities(region) : { list: [], failed: false };
      const city = res.list.length ? pickMiddle(res.list) : { name: region.name, center: region.center };
      setText(city.name, res.list.length ? `${country.name} - ${region.name} - ${city.name}` : "Город не найден — показан центр региона");
      const [, geo] = await Promise.all([fly(city.center, ZOOM_CITY),
        res.list.length ? API.cityBorder(city, region.name) : null]);
      setBorder("city", geo);
    } else {
      clearBorders("country", "region", "city");
      setText("ЗЕМЛЯ", "Нажмите на кубик");
      await fly(EARTH.center, EARTH.zoom);
    }
  } catch (e) {
    console.error(e);
    level = prev;
    setText("ОШИБКА", "Не удалось загрузить данные. Проверьте интернет и фильтры.");
  } finally { setBusy(false); }
});

$("back").addEventListener("click", async () => {
  if (busy || level === 0) return;
  level--;
  setBusy(true);
  try {
    if (level === 2) {
      clearBorders("city");
      setText(region.name, region.sub);
      await fly(region.center, region.zoom);
    } else if (level === 1) {
      clearBorders("region", "city");
      setText(country.name, "Страна");
      await fly(country.center, country.zoom);
    } else {
      clearBorders("country", "region", "city");
      setText("ЗЕМЛЯ", "Нажмите на кубик");
      await fly(EARTH.center, EARTH.zoom);
    }
  } finally { setBusy(false); }
});

$("toggleUi").addEventListener("click", () => document.body.classList.toggle("hide-ui"));
$("fs").addEventListener("click", () =>
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
