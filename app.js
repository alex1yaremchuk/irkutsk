const DATA_URL = "./parcels.geojson";
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRAfXw_YaBPg3ofRp-75nvcVibslg-AeY-HwhpYYQXDcaZTzP3hPBupBoKROsHstC3hRDOl_zPpX1jh/pub?gid=0&single=true&output=csv";
const SHEET_REFRESH_MS = 30_000;
const CADASTRAL_PREFIX = "38:06:111215:";
const LABELS_MIN_ZOOM = 16;
const LABEL_OFFSET_EAST_METERS = 0;
const LABEL_OFFSET_NORTH_METERS = 12;
const TELEGRAM_USERNAME = "ayarem";
const WHATSAPP_PHONE = "79679670322";

const STATUS_LABELS = {
  free: "свободно",
  reserved: "забронировано",
  sold: "продано",
};

const STATUS_COLOR_VARS = {
  free: {
    fill: "--free",
    hover: "--free-hover",
    fallbackFill: "#309F48",
    fallbackHover: "#46bf5f",
  },
  reserved: {
    fill: "--reserved",
    hover: "--reserved-hover",
    fallbackFill: "#94a3b8",
    fallbackHover: "#a5b1c4",
  },
  sold: {
    fill: "--sold",
    hover: "--sold-hover",
    fallbackFill: "#636363",
    fallbackHover: "#484848",
  },
};

const openedState = { marker: null, parcelId: null, node: null };
const sheetState = { timestamp: null, lastLoadAt: null, error: null };

function trimCell(value) {
  return String(value ?? "")
    .replace(/\u00A0/g, " ")
    .trim();
}

function formatRub(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("ru-RU").format(Number(value)) + " ₽";
}

function formatArea(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return (
    new Intl.NumberFormat("ru-RU").format(Math.round(Number(value))) + " м²"
  );
}

function formatSheetTimestamp(value) {
  return value ? value : "нет данных";
}

function getCssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

function getStatusPalette(status) {
  const config = STATUS_COLOR_VARS[status] || STATUS_COLOR_VARS.free;
  return {
    fill: getCssColor(config.fill, config.fallbackFill),
    hover: getCssColor(config.hover, config.fallbackHover),
    stroke: getCssColor("--parcel-stroke", "#4c566a"),
  };
}

function parseNumberRu(value) {
  const cleaned = trimCell(value).replace(/\s+/g, "").replace(",", ".");
  if (!cleaned) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

function normalizeStatus(value) {
  const text = trimCell(value).toLowerCase();
  if (!text) return null;
  if (text.includes("свобод")) return "free";
  if (text.includes("брон") || text.includes("резерв")) return "reserved";
  if (text.includes("прод")) return "sold";
  return null;
}

function toFullCadnum(value) {
  const text = trimCell(value);
  if (!text) return null;
  if (/^\d{2}:\d{2}:\d{6,7}:\d+$/.test(text)) return text;
  if (/^\d+$/.test(text)) return `${CADASTRAL_PREFIX}${text}`;
  const match = text.match(/\b\d{2}:\d{2}:\d{6,7}:\d+\b/);
  return match ? match[0] : null;
}

function parseCsvRows(text) {
  const source = String(text ?? "");
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"') {
      const next = source[i + 1];
      if (inQuotes && next === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }

  row.push(field);
  if (row.length > 1 || trimCell(row[0])) rows.push(row);
  return rows;
}

function parseSheetCsv(text) {
  const rows = parseCsvRows(text);
  const timestamp = trimCell(rows[0]?.[1] || rows[0]?.[0]);
  const map = new Map();

  rows.slice(2).forEach((cells) => {
    const cadnum = toFullCadnum(cells[0]);
    if (!cadnum) return;
    map.set(cadnum, {
      cadnum,
      lot_number: trimCell(cells[1]),
      status: normalizeStatus(cells[2]),
      area_m2: parseNumberRu(cells[3]),
      price_rub: parseNumberRu(cells[4]),
    });
  });

  return { timestamp, map };
}

async function loadSheetData() {
  const cacheBust =
    (SHEET_CSV_URL.includes("?") ? "&" : "?") + "cb=" + Date.now();
  const response = await fetch(SHEET_CSV_URL + cacheBust, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Google Sheet HTTP ${response.status}`);
  return parseSheetCsv(await response.text());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getPolygonRings(feature) {
  const geometry = feature.geometry || {};
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates[0] || [];
  return [];
}

function getOuterRing(feature) {
  return getPolygonRings(feature)[0] || [];
}

function isPointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function isPointInFeature(lon, lat, feature) {
  const rings = getPolygonRings(feature);
  if (!rings.length || !isPointInRing(lon, lat, rings[0])) return false;
  return !rings.slice(1).some((ring) => isPointInRing(lon, lat, ring));
}

function findParcelByLngLat(features, lngLat) {
  if (!Array.isArray(lngLat) || lngLat.length !== 2) return null;
  const lon = Number(lngLat[0]);
  const lat = Number(lngLat[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return (
    features.find((feature) => isPointInFeature(lon, lat, feature)) || null
  );
}

function extractLngLat(object, event) {
  const candidates = [
    object?.coordinates,
    object?.lngLat,
    event?.coordinates,
    event?.lngLat,
  ];
  for (const value of candidates) {
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      Number.isFinite(Number(value[0])) &&
      Number.isFinite(Number(value[1]))
    ) {
      return [Number(value[0]), Number(value[1])];
    }
  }
  return null;
}

function ringCenter(ring) {
  if (!ring.length) return null;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  ring.forEach(([lon, lat]) => {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  });
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

function offsetLngLatByMeters([lon, lat], eastMeters, northMeters) {
  const metersPerLatDegree = 111_320;
  const latRadians = (lat * Math.PI) / 180;
  const metersPerLonDegree = metersPerLatDegree * Math.cos(latRadians);
  const lonOffset = metersPerLonDegree ? eastMeters / metersPerLonDegree : 0;
  const latOffset = northMeters / metersPerLatDegree;
  return [lon + lonOffset, lat + latOffset];
}

function getBounds(features) {
  const coords = features.flatMap((feature) => getOuterRing(feature));
  const lons = coords.map((coord) => coord[0]);
  const lats = coords.map((coord) => coord[1]);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)],
  ];
}

function getParcelStyle(parcel, isHover = false) {
  const palette = getStatusPalette(parcel.properties.status);
  return {
    fill: isHover ? palette.hover : palette.fill,
    fillOpacity: 1,
    stroke: [{ color: palette.stroke, width: isHover ? 3 : 2 }],
  };
}

function buildContactText(parcel) {
  const p = parcel.properties;
  return `Здравствуйте! Интересует участок ${p.lot_number || p.short_num} (${p.cadnum}).`;
}

function buildTelegramUrl(parcel) {
  return `https://t.me/${TELEGRAM_USERNAME}?text=${encodeURIComponent(buildContactText(parcel))}`;
}

function buildWhatsAppUrl(parcel) {
  return `https://wa.me/${WHATSAPP_PHONE}?text=${encodeURIComponent(buildContactText(parcel))}`;
}

function renderPopup(parcel) {
  const p = parcel.properties;
  const palette = getStatusPalette(p.status);
  const title = p.lot_number
    ? `Участок №${escapeHtml(p.lot_number)}`
    : `Участок ${escapeHtml(p.short_num)}`;
  return `
    <button class="parcel-popup__close" type="button" aria-label="Закрыть">×</button>
    <div class="parcel-popup__title">${title}</div>
    <div class="parcel-popup__row"><span>Кадастровый номер</span><strong>${escapeHtml(p.cadnum)}</strong></div>
    <div class="parcel-popup__row"><span>Площадь</span><strong>${formatArea(p.area_m2)}</strong></div>
    <div class="parcel-popup__row"><span>Цена</span><strong>${formatRub(p.price_rub)}</strong></div>
    <div class="parcel-popup__row">
      <span>Статус</span>
      <strong><span class="parcel-popup__status" style="background:${palette.fill}">${STATUS_LABELS[p.status] || "—"}</span></strong>
    </div>
    <div class="parcel-popup__actions">
      <a class="contact-button contact-button--tg" href="${buildTelegramUrl(parcel)}" target="_blank" rel="noopener noreferrer">Telegram</a>
      <a class="contact-button contact-button--wa" href="${buildWhatsAppUrl(parcel)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>
    </div>
  `;
}

function renderTooltip(parcel) {
  const p = parcel.properties;
  const title = p.lot_number
    ? `Участок №${escapeHtml(p.lot_number)}`
    : `Участок ${escapeHtml(p.short_num)}`;
  return `
    <div class="parcel-tooltip__title">${title}</div>
    <div class="parcel-tooltip__status">${STATUS_LABELS[p.status] || "—"}</div>
  `;
}

function closePopup(map, interactiveEntities) {
  if (openedState.marker) {
    map.removeChild(openedState.marker);
    if (interactiveEntities) interactiveEntities.delete(openedState.marker);
  }
  openedState.marker = null;
  openedState.parcelId = null;
  openedState.node = null;
}

function openPopup(map, parcel, YMapMarker, interactiveEntities) {
  const parcelId = parcel.properties.cadnum;
  if (openedState.parcelId === parcelId && openedState.marker) {
    if (openedState.node) openedState.node.innerHTML = renderPopup(parcel);
    return;
  }
  closePopup(map, interactiveEntities);
  const center = ringCenter(getOuterRing(parcel));
  if (!center) return;
  const node = document.createElement("div");
  node.className = "parcel-popup";
  node.innerHTML = renderPopup(parcel);
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target.closest(".parcel-popup__close")) {
      closePopup(map, interactiveEntities);
    }
  });
  const marker = new YMapMarker(
    {
      coordinates: center,
      zIndex: 3000,
      disableRoundCoordinates: true,
    },
    node,
  );
  map.addChild(marker);
  interactiveEntities.add(marker);
  openedState.marker = marker;
  openedState.parcelId = parcelId;
  openedState.node = node;
}

function createLabelNode(parcel) {
  const node = document.createElement("div");
  node.className = "parcel-label";
  const label = parcel.properties.lot_number || parcel.properties.short_num;
  node.innerHTML = `<span class="parcel-label__text">${escapeHtml(label)}</span>`;
  return node;
}

function updateLabelNode(node, parcel) {
  const textNode = node?.querySelector(".parcel-label__text");
  if (!textNode) return;
  textNode.textContent =
    parcel.properties.lot_number || parcel.properties.short_num;
}

function updateStats(features) {
  const statsNode = document.getElementById("stats");
  if (!statsNode) return;
  const counts = { free: 0, reserved: 0, sold: 0 };
  features.forEach((feature) => {
    counts[feature.properties.status] =
      (counts[feature.properties.status] || 0) + 1;
  });
  statsNode.innerHTML = `
    <div class="stat"><strong>${counts.free}</strong><span>свободно</span></div>
    <div class="stat"><strong>${counts.reserved}</strong><span>бронь</span></div>
    <div class="stat"><strong>${counts.sold}</strong><span>продано</span></div>
  `;
}

function updateSheetStatus() {
  const node = document.getElementById("sheet-status");
  if (!node) return;
  if (sheetState.error) {
    node.textContent = `Google Sheet: ошибка загрузки, показаны последние данные. ${sheetState.error}`;
    return;
  }
  node.textContent = `Google Sheet: обновлено ${formatSheetTimestamp(sheetState.timestamp)}. Проверка каждые 30 секунд.`;
}

function applySheetData(features, sheetData) {
  let changed = false;
  features.forEach((feature) => {
    const row = sheetData.map.get(feature.properties.cadnum);
    if (!row) return;
    const next = {
      lot_number: row.lot_number || feature.properties.lot_number,
      status: row.status || feature.properties.status,
      area_m2: Number.isFinite(row.area_m2)
        ? row.area_m2
        : feature.properties.area_m2,
      price_rub: Number.isFinite(row.price_rub)
        ? row.price_rub
        : feature.properties.price_rub,
    };
    Object.entries(next).forEach(([key, value]) => {
      if (feature.properties[key] !== value) {
        feature.properties[key] = value;
        changed = true;
      }
    });
  });
  return changed;
}

async function init() {
  if (!window.ymaps3) {
    document.getElementById("map").textContent =
      "Yandex Maps API не загрузился.";
    return;
  }
  await ymaps3.ready;
  const {
    YMap,
    YMapFeature,
    YMapMarker,
    YMapListener,
    YMapDefaultSchemeLayer,
    YMapDefaultFeaturesLayer,
  } = ymaps3;

  const response = await fetch(`${DATA_URL}?v=20260507-02`, {
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error("Не удалось загрузить parcels.geojson");
  const data = await response.json();
  const allFeatures = data.features || [];
  let visibleFeatures = [];
  updateStats(visibleFeatures);

  const bounds = getBounds(allFeatures);
  const center = [
    (bounds[0][0] + bounds[1][0]) / 2,
    (bounds[0][1] + bounds[1][1]) / 2,
  ];

  const mapElement = document.getElementById("map");
  const map = new YMap(mapElement, {
    location: { center, zoom: 16 },
    zoomRange: { min: 12, max: 19 },
    mode: "vector",
    copyrights: false,
    distribution: false,
  });
  map.addChild(new YMapDefaultSchemeLayer({}));
  map.addChild(new YMapDefaultFeaturesLayer({}));

  const interactiveEntities = new Set();
  const featureByEntity = new Map();
  const labelByEntity = new Map();
  const featureByCadnum = new Map();
  const labelMarkerByCadnum = new Map();
  const labelByCadnum = new Map();
  const visibleLabelCadnums = new Set();
  const tooltipNode = document.createElement("div");
  tooltipNode.className = "parcel-tooltip";
  document.body.appendChild(tooltipNode);
  let currentZoom = 16;
  let hoveredParcelId = null;
  let hoveredParcel = null;
  let lastPointerLngLat = null;
  let lastInteractiveClickAt = 0;
  let pointerBlocksHover = false;
  const nowTs = () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const markInteractiveClick = () => {
    lastInteractiveClickAt = nowTs();
  };
  const isEventOverPopup = (event) => {
    if (event?.target?.closest?.(".parcel-popup")) return true;
    if (!Number.isFinite(event?.clientX) || !Number.isFinite(event?.clientY))
      return false;
    return !!document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest?.(".parcel-popup");
  };
  const moveTooltip = (event) => {
    pointerBlocksHover = isEventOverPopup(event);
    tooltipNode.style.left = `${event.clientX}px`;
    tooltipNode.style.top = `${event.clientY}px`;
    if (pointerBlocksHover) setHoveredParcel(null);
  };
  const hideTooltip = () => {
    tooltipNode.classList.remove("is-visible");
  };
  const showTooltip = (parcel) => {
    if (!parcel || pointerBlocksHover) {
      hideTooltip();
      return;
    }
    tooltipNode.innerHTML = renderTooltip(parcel);
    tooltipNode.classList.add("is-visible");
  };
  const attachPopupHoverGuard = () => {
    const node = openedState.node;
    if (!node || node.dataset.hoverGuard === "1") return;
    node.dataset.hoverGuard = "1";
    node.addEventListener("mouseenter", () => {
      pointerBlocksHover = true;
      setHoveredParcel(null);
    });
    node.addEventListener("mousemove", (event) => {
      pointerBlocksHover = true;
      moveTooltip(event);
      setHoveredParcel(null);
    });
    node.addEventListener("mouseleave", () => {
      pointerBlocksHover = false;
    });
  };
  const openParcelPopup = (parcel) => {
    hideTooltip();
    openPopup(map, parcel, YMapMarker, interactiveEntities);
    attachPopupHoverGuard();
  };

  function setHoveredParcel(parcel) {
    if (pointerBlocksHover) parcel = null;
    const nextId = parcel?.properties?.cadnum || null;
    hoveredParcel = parcel || null;
    if (nextId === hoveredParcelId) return;
    if (hoveredParcelId) {
      const previousFeature = featureByCadnum.get(hoveredParcelId);
      const previousParcel = previousFeature
        ? featureByEntity.get(previousFeature)
        : null;
      if (previousFeature && previousParcel) {
        previousFeature.update({ style: getParcelStyle(previousParcel) });
      }
    }
    hoveredParcelId = nextId;
    mapElement.classList.toggle("is-parcel-hover", !!parcel);
    if (parcel) {
      const feature = featureByCadnum.get(nextId);
      if (feature) feature.update({ style: getParcelStyle(parcel, true) });
      showTooltip(parcel);
    } else {
      hideTooltip();
    }
  }

  function refreshMapFromProperties() {
    visibleFeatures.forEach((parcel) => {
      const feature = featureByCadnum.get(parcel.properties.cadnum);
      if (feature)
        feature.update({
          style: getParcelStyle(
            parcel,
            hoveredParcelId === parcel.properties.cadnum,
          ),
        });
      updateLabelNode(labelByCadnum.get(parcel.properties.cadnum), parcel);
    });
    updateStats(visibleFeatures);
    if (openedState.parcelId && openedState.node) {
      const openedParcel = visibleFeatures.find(
        (feature) => feature.properties.cadnum === openedState.parcelId,
      );
      if (openedParcel) openedState.node.innerHTML = renderPopup(openedParcel);
    }
  }

  function shouldShowLabels() {
    return currentZoom >= LABELS_MIN_ZOOM;
  }

  function addLabelMarker(cadnum) {
    if (visibleLabelCadnums.has(cadnum)) return;
    const labelMarker = labelMarkerByCadnum.get(cadnum);
    const parcel = visibleFeatures.find(
      (feature) => feature.properties.cadnum === cadnum,
    );
    if (!labelMarker || !parcel) return;
    map.addChild(labelMarker);
    labelByEntity.set(labelMarker, parcel);
    visibleLabelCadnums.add(cadnum);
  }

  function removeLabelMarker(cadnum) {
    if (!visibleLabelCadnums.has(cadnum)) return;
    const labelMarker = labelMarkerByCadnum.get(cadnum);
    if (labelMarker) {
      map.removeChild(labelMarker);
      labelByEntity.delete(labelMarker);
    }
    visibleLabelCadnums.delete(cadnum);
  }

  function updateLabelVisibility() {
    labelMarkerByCadnum.forEach((_, cadnum) => {
      if (shouldShowLabels()) {
        addLabelMarker(cadnum);
      } else {
        removeLabelMarker(cadnum);
      }
    });
  }

  function addParcelToMap(parcel) {
    const cadnum = parcel.properties.cadnum;
    if (featureByCadnum.has(cadnum)) return;

    const rings = getPolygonRings(parcel);
    if (!rings.length) return;

    let mapFeature = null;
    mapFeature = new YMapFeature({
      geometry: { type: "Polygon", coordinates: rings },
      style: getParcelStyle(parcel),
      onClick: () => {
        markInteractiveClick();
        openParcelPopup(parcel);
      },
      onMouseEnter: () => setHoveredParcel(parcel),
      onMouseLeave: () => setHoveredParcel(null),
    });
    map.addChild(mapFeature);
    interactiveEntities.add(mapFeature);
    featureByEntity.set(mapFeature, parcel);
    featureByCadnum.set(cadnum, mapFeature);

    const centerPoint = ringCenter(getOuterRing(parcel));
    if (centerPoint) {
      const labelPoint = offsetLngLatByMeters(
        centerPoint,
        LABEL_OFFSET_EAST_METERS,
        LABEL_OFFSET_NORTH_METERS,
      );
      const labelNode = createLabelNode(parcel);
      const labelMarker = new YMapMarker(
        {
          coordinates: labelPoint,
          zIndex: 2200,
          disableRoundCoordinates: true,
        },
        labelNode,
      );
      labelMarkerByCadnum.set(cadnum, labelMarker);
      labelByCadnum.set(cadnum, labelNode);
      if (shouldShowLabels()) addLabelMarker(cadnum);
    }
  }

  function removeParcelFromMap(cadnum) {
    const feature = featureByCadnum.get(cadnum);
    if (feature) {
      map.removeChild(feature);
      interactiveEntities.delete(feature);
      featureByEntity.delete(feature);
      featureByCadnum.delete(cadnum);
    }

    const labelMarker = labelMarkerByCadnum.get(cadnum);
    if (labelMarker) {
      if (visibleLabelCadnums.has(cadnum)) map.removeChild(labelMarker);
      labelByEntity.delete(labelMarker);
      labelMarkerByCadnum.delete(cadnum);
      labelByCadnum.delete(cadnum);
      visibleLabelCadnums.delete(cadnum);
    }

    if (hoveredParcelId === cadnum) setHoveredParcel(null);
    if (openedState.parcelId === cadnum) closePopup(map, interactiveEntities);
  }

  function syncVisibleParcels(sheetData) {
    const visibleCadnums = new Set(sheetData.map.keys());
    allFeatures.forEach((parcel) => {
      if (visibleCadnums.has(parcel.properties.cadnum)) addParcelToMap(parcel);
    });

    Array.from(featureByCadnum.keys()).forEach((cadnum) => {
      if (!visibleCadnums.has(cadnum)) removeParcelFromMap(cadnum);
    });

    visibleFeatures = allFeatures.filter((parcel) =>
      featureByCadnum.has(parcel.properties.cadnum),
    );
    updateLabelVisibility();
    refreshMapFromProperties();
  }

  async function refreshSheetData({ force = false } = {}) {
    try {
      const sheetData = await loadSheetData();
      sheetState.error = null;
      sheetState.lastLoadAt = Date.now();

      if (
        !force &&
        sheetData.timestamp &&
        sheetData.timestamp === sheetState.timestamp
      ) {
        updateSheetStatus();
        return;
      }

      sheetState.timestamp = sheetData.timestamp || sheetState.timestamp;
      applySheetData(allFeatures, sheetData);
      syncVisibleParcels(sheetData);
      updateSheetStatus();
    } catch (error) {
      sheetState.error = error.message;
      updateSheetStatus();
      console.error(error);
    }
  }

  const listener = new YMapListener({
    layer: "any",
    onUpdate: (event = {}) => {
      const location = event.location || event;
      const nextZoom = Number(location?.zoom);
      if (!Number.isFinite(nextZoom) || nextZoom === currentZoom) return;
      currentZoom = nextZoom;
      updateLabelVisibility();
    },
    onClick: (object, event) => {
      if (pointerBlocksHover) return;
      const entity = object?.entity || null;
      if (entity && labelByEntity.has(entity)) {
        const parcel = labelByEntity.get(entity);
        if (parcel) {
          markInteractiveClick();
          openParcelPopup(parcel);
          return;
        }
      }
      if (nowTs() - lastInteractiveClickAt < 160) return;
      const entityParcel = featureByEntity.get(entity);
      if (entityParcel) {
        markInteractiveClick();
        openParcelPopup(entityParcel);
        return;
      }
      const clickedParcel = findParcelByLngLat(
        visibleFeatures,
        extractLngLat(object, event) || lastPointerLngLat,
      );
      if (clickedParcel) {
        markInteractiveClick();
        openParcelPopup(clickedParcel);
        return;
      }
      if (!entity || !interactiveEntities.has(entity)) {
        closePopup(map, interactiveEntities);
      }
    },
    onMouseMove: (object, event) => {
      if (pointerBlocksHover) {
        setHoveredParcel(null);
        return;
      }
      const entity = object?.entity || null;
      lastPointerLngLat = extractLngLat(object, event) || lastPointerLngLat;
      const parcel =
        featureByEntity.get(entity) ||
        labelByEntity.get(entity) ||
        findParcelByLngLat(visibleFeatures, lastPointerLngLat);
      setHoveredParcel(parcel);
    },
  });
  map.addChild(listener);

  mapElement.addEventListener("click", () => {
    if (nowTs() - lastInteractiveClickAt < 160) return;
    const parcel =
      hoveredParcel || findParcelByLngLat(visibleFeatures, lastPointerLngLat);
    if (!parcel) {
      closePopup(map, interactiveEntities);
      return;
    }
    markInteractiveClick();
    openParcelPopup(parcel);
  });
  document.addEventListener("mousemove", moveTooltip);
  mapElement.addEventListener("mouseleave", () => setHoveredParcel(null));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePopup(map, interactiveEntities);
    }
  });

  await refreshSheetData({ force: true });
  setInterval(() => refreshSheetData(), SHEET_REFRESH_MS);

  setTimeout(() => {
    map.setLocation({ bounds, duration: 0 });
  }, 0);
}

init().catch((error) => {
  console.error(error);
  document.getElementById("map").textContent =
    `Ошибка запуска карты: ${error.message}`;
});
