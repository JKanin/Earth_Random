// Режим «Россия». Города — список ru-cities (1117 городов, русские названия, регион, координаты).
// Контуры регионов берутся из geoBoundaries по коду cca3.
// Простой разбор CSV (с кавычками)
function parseCSV(t) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

let _ruTowns = null;

MODES.ru = {
  label: "🇷🇺 Россия",
  cca2: "RU",
  cca3: "RUS",
  async towns() {
    if (_ruTowns) return _ruTowns;
    const r = await fetch("https://cdn.jsdelivr.net/gh/epogrebnyak/ru-cities@main/assets/towns.csv");
    if (!r.ok) throw new Error("http " + r.status);
    const rows = parseCSV(await r.text());
    const h = rows.shift().map(x => x.replace(/^\uFEFF/, "").trim()), ix = n => h.indexOf(n);
    const towns = rows.map(c => ({ name: c[ix("city")], region: c[ix("region_name")],
      x: parseFloat(c[ix("lon")]), y: parseFloat(c[ix("lat")]) })).filter(t => t.name && isFinite(t.x) && isFinite(t.y));
    if (!towns.length) throw new Error("пустой файл");
    return (_ruTowns = towns);
  }
};
