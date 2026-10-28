const $ = id => document.getElementById(id);
// Средний по размеру город: список отсортирован по населению (от крупных к мелким),
// берём случайный из средней трети
function pickMiddle(list) {
  const n = list.length, from = Math.floor(n / 3), to = Math.max(from + 1, Math.ceil(2 * n / 3));
  return pick(list.slice(from, to));
}
const pick = a => a[Math.floor(Math.random() * a.length)];
const EARTH = { center: [15, 30], zoom: 1.5 };
const ZOOM_REGION = 7, ZOOM_CITY = 12;
const COLORS = { country: "#c9ffb0", region: "#ffe27a", city: "#7ad7ff" };

// ---- Карта: спутниковые снимки Esri на глобусе
const map = new maplibregl.Map({
  container: "map",
  style: { version: 8,
    sources: { sat: { type: "raster", tileSize: 256, maxzoom: 18,
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      attribution: "Esri, Maxar, Earthstar Geographics & GIS User Community | © OpenStreetMap | geoBoundaries, Natural Earth, world-atlas, ru-cities" } },
    layers: [{ id: "sat", type: "raster", source: "sat" }] },
  center: EARTH.center, zoom: EARTH.zoom, maxPitch: 0,
  attributionControl: false
});
map.addControl(new maplibregl.AttributionControl(), "top-left");   // подпись карты — в левом верхнем углу
map.on("style.load", () => map.setProjection({ type: "globe" }));

// ---- Слои границ: страна, регион, город
const EMPTY = { type: "FeatureCollection", features: [] };
map.on("load", () => {
  for (const [id, color] of Object.entries(COLORS)) {
    map.addSource(id, { type: "geojson", data: EMPTY });
    map.addLayer({ id: id + "-fill", type: "fill", source: id, paint: { "fill-color": color, "fill-opacity": 0 } });
    map.addLayer({ id: id + "-line", type: "line", source: id,
      paint: { "line-color": color, "line-width": 2.5, "line-opacity": 0.95 } });
  }
});
function setBorder(id, geometry) {
  const src = map.getSource(id);
  if (src) src.setData(geometry ? { type: "Feature", geometry: outline(geometry), properties: {} } : EMPTY);
}
const clearBorders = (...ids) => ids.forEach(id => setBorder(id, null));

const FLY_MS = 3000;
let flying = false, flyTarget = null;
const fly = (center, zoom) => new Promise(res => {
  flying = true; flyTarget = { center, zoom };
  $("skip").disabled = false;
  map.once("moveend", () => { flying = false; $("skip").disabled = true; res(); });
  map.flyTo({ center, zoom, duration: FLY_MS, essential: true });
});

// «Пропустить»: обрываем перелёт и сразу ставим камеру в конечную точку
$("skip").addEventListener("click", () => {
  if (!flying) return;
  const t = flyTarget;
  map.stop();
  map.jumpTo({ center: t.center, zoom: t.zoom });
});

// Масштаб, при котором рамка bbox [x0,y0,x1,y1] помещается в экран
function zoomFor(b) {
  const d = Math.max(b[2] - b[0], (b[3] - b[1]) * 1.3, 0.05);
  const px = Math.min(innerWidth, innerHeight * 1.4) * 0.75;
  return Math.min(9, Math.max(3, Math.log2(px / 256 * 360 / d)));
}

// ---- Текст с эффектом «расшифровки»
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

// ---- Логика: 0 Земля -> 1 страна -> 2 регион -> 3 город -> 0
let level = 0, busy = false, country, region;
// Режим страны (файлы в modes/): выбранный в списке режим или null для «Страны ООН»
const MODE = () => MODES[$("fUn").value] || null;
const inMode = () => !!MODE();
for (const [key, m] of Object.entries(MODES)) {      // пункты списка создаются из зарегистрированных режимов
  const o = document.createElement("option");
  o.value = key; o.textContent = m.label; $("fUn").appendChild(o);
}

// Режим страны: можно выбрать конкретный регион (тогда случайным будет только город)
let modeList = [];
const fixedRegion = () => (inMode() && $("fSubject").value !== "" ? modeList[+$("fSubject").value] : null);
async function fillSubjects() {
  const sel = $("fSubject");
  sel.innerHTML = '<option value="">Случайный регион</option>';
  try {
    modeList = (await API.regionsMode(MODE())).list;
    modeList.map((r, i) => ({ n: r.name, i })).sort((a, b) => a.n.localeCompare(b.n, "ru")).forEach(o => {
      const e = document.createElement("option");
      e.value = o.i; e.textContent = o.n; sel.appendChild(e);
    });
  } catch (e) { console.warn("Список регионов:", e); }
}

// Режим страны: белый контур; обычный режим — зелёный (заливки нигде нет)
function styleCountry() {
  if (!map.getLayer("country-line")) return;
  map.setPaintProperty("country-line", "line-color", inMode() ? "#ffffff" : COLORS.country);
}

// История выбора: сколько последних значений не повторяется (регионы — 15, города — 5)
const HIST_LIMIT = { reg: 15, city: 5 };
const hist = { reg: [], city: [] };
function pickFresh(list, kind, key) {
  const h = hist[kind], fresh = list.filter(x => !h.includes(key(x)));
  const x = pick(fresh.length ? fresh : list);
  h.push(key(x)); if (h.length > HIST_LIMIT[kind]) h.shift();
  return x;
}

// Блокировка кнопок на время перелёта; «Назад» неактивна на уровне «Земля»
function setBusy(v) {
  busy = v;
  $("dice").disabled = v;
  $("fUn").disabled = v;
  $("fSubject").disabled = v;
  $("fRegion").disabled = v || inMode();
  $("back").disabled = v || level === 0;
}

$("dice").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  const prev = level;
  try {
    level = (level + 1) % 4;
    // в режиме страны отдаляемся до этой страны, а не до Земли; при выбранном регионе с города идём к следующему городу
    if (inMode() && level === 0) level = prev === 3 && fixedRegion() ? 3 : 1;
    if (level === 1) {
      clearBorders("country", "region", "city");
      setText("ЗАГРУЗКА…");
      const all = await API.countries();
      const list = inMode() ? all.filter(c => c.cca2 === MODE().cca2)
        : all.filter(c => c.un && (!$("fRegion").value || c.continent === $("fRegion").value));
      if (!list.length) throw new Error("empty");
      country = pick(list);
      styleCountry();
      setText(country.name, "Страна");
      const [, geo] = await Promise.all([fly(country.center, country.zoom), API.countryBorder(country)]);
      setBorder("country", geo);
    } else if (level === 2) {
      clearBorders("region", "city");
      setText("ПОИСК РЕГИОНА…", country.name);
      const res = inMode() ? await API.regionsMode(MODE()) : await API.regions(country);
      region = res.list.length ? (fixedRegion() || (inMode() ? pickFresh(res.list, "reg", r => r.name) : pick(res.list))) : { name: country.name, center: country.center };
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
      const res = inMode() ? await API.citiesMode(region, MODE())
        : (region.geometry || region.qid || region.osm) ? await API.cities(region) : { list: [], failed: false };
      const city = res.list.length ? (inMode() ? pickFresh(res.list, "city", c => c.name + c.center) : pickMiddle(res.list)) : { name: region.name, center: region.center };
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

// ---- Переключение режима: «Страны ООН» или страна из modes/
$("fUn").addEventListener("change", async () => {
  if (busy) return;
  setBusy(true);
  hist.reg = []; hist.city = [];
  clearBorders("country", "region", "city");
  $("fSubject").hidden = !inMode();
  $("fRegion").hidden = inMode();
  try {
    styleCountry();
    if (inMode()) {                       // сразу приближаемся к стране
      country = (await API.countries()).find(c => c.cca2 === MODE().cca2);
      level = 1;
      const loaded = fillSubjects();     // список регионов грузится параллельно с перелётом
      setText(country.name, "Страна");
      const [, geo] = await Promise.all([fly(country.center, country.zoom), API.countryBorder(country)]);
      setBorder("country", geo);
      await loaded;
    } else {
      level = 0;
      $("fSubject").value = "";
      setText("ЗЕМЛЯ", "Нажмите на кубик");
      await fly(EARTH.center, EARTH.zoom);
    }
  } catch (e) {
    console.error(e);
    level = 0;
    setText("ОШИБКА", "Не удалось загрузить данные. Проверьте интернет.");
  } finally { setBusy(false); }
});

// ---- Выбор конкретного региона страны
$("fSubject").addEventListener("change", async () => {
  if (busy || !inMode()) return;
  setBusy(true);
  clearBorders("region", "city");
  try {
    const r = fixedRegion();
    if (r) {
      region = r; level = 2;
      region.sub = `${country.name} - ${region.name}`;
      region.zoom = region.bbox ? zoomFor(region.bbox) : ZOOM_REGION;
      setText(region.name, region.sub);
      const [, geo] = await Promise.all([fly(region.center, region.zoom), API.regionBorder(region)]);
      setBorder("region", geo);
    } else {                            // «Случайный регион» — возвращаемся к виду всей России
      level = 1;
      setText(country.name, "Страна");
      await fly(country.center, country.zoom);
    }
  } catch (e) {
    console.error(e);
    setText("ОШИБКА", "Не удалось загрузить данные.");
  } finally { setBusy(false); }
});

// ---- Кнопка «Назад»: на уровень выше
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

// ---- Кнопки справа сверху
$("toggleUi").addEventListener("click", () => document.body.classList.toggle("hide-ui"));
$("fs").addEventListener("click", () =>
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
