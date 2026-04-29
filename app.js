const DATA_URL = "./data/demo_parcels.geojson";
const TELEGRAM_USERNAME = "ayarem";
const WHATSAPP_PHONE = "79679670322";

const STATUS_LABELS = {
  free: "свободно",
  reserved: "забронировано",
  sold: "продано",
};

const STATUS_COLORS = {
  free: { fill: "#2f9e44", hover: "#40c057", stroke: "#14532d" },
  reserved: { fill: "#f59f00", hover: "#fab005", stroke: "#92400e" },
  sold: { fill: "#8b1e2d", hover: "#a61e34", stroke: "#450a0a" },
};

const openedState = { marker: null, parcelId: null, node: null };

function formatRub(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("ru-RU").format(Number(value)) + " ₽";
}

function formatArea(value) {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat("ru-RU").format(Math.round(Number(value))) + " м²";
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
    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
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
  return features.find((feature) => isPointInFeature(lon, lat, feature)) || null;
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
  const palette = STATUS_COLORS[parcel.properties.status] || STATUS_COLORS.free;
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
  const palette = STATUS_COLORS[p.status] || STATUS_COLORS.free;
  const title = p.lot_number ? `Участок №${escapeHtml(p.lot_number)}` : `Участок ${escapeHtml(p.short_num)}`;
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
  const marker = new YMapMarker({
    coordinates: center,
    zIndex: 3000,
    disableRoundCoordinates: true,
  }, node);
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

function updateStats(features) {
  const counts = { free: 0, reserved: 0, sold: 0 };
  features.forEach((feature) => {
    counts[feature.properties.status] = (counts[feature.properties.status] || 0) + 1;
  });
  document.getElementById("stats").innerHTML = `
    <div class="stat"><strong>${counts.free}</strong><span>свободно</span></div>
    <div class="stat"><strong>${counts.reserved}</strong><span>бронь</span></div>
    <div class="stat"><strong>${counts.sold}</strong><span>продано</span></div>
  `;
}

async function init() {
  if (!window.ymaps3) {
    document.getElementById("map").textContent = "Yandex Maps API не загрузился.";
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

  const response = await fetch(`${DATA_URL}?v=20260429-02`, { cache: "no-store" });
  if (!response.ok) throw new Error("Не удалось загрузить demo_parcels.geojson");
  const data = await response.json();
  const features = data.features || [];
  updateStats(features);

  const bounds = getBounds(features);
  const center = [
    (bounds[0][0] + bounds[1][0]) / 2,
    (bounds[0][1] + bounds[1][1]) / 2,
  ];

  const map = new YMap(document.getElementById("map"), {
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
  let hoveredParcelId = null;
  let hoveredParcel = null;
  let lastPointerLngLat = null;
  let lastInteractiveClickAt = 0;
  const nowTs = () => (
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now()
  );
  const markInteractiveClick = () => {
    lastInteractiveClickAt = nowTs();
  };

  function setHoveredParcel(parcel) {
    const nextId = parcel?.properties?.cadnum || null;
    hoveredParcel = parcel || null;
    if (nextId === hoveredParcelId) return;
    if (hoveredParcelId) {
      const previousFeature = featureByCadnum.get(hoveredParcelId);
      const previousParcel = previousFeature ? featureByEntity.get(previousFeature) : null;
      if (previousFeature && previousParcel) {
        previousFeature.update({ style: getParcelStyle(previousParcel) });
      }
    }
    hoveredParcelId = nextId;
    if (parcel) {
      const feature = featureByCadnum.get(nextId);
      if (feature) feature.update({ style: getParcelStyle(parcel, true) });
    }
  }

  const listener = new YMapListener({
    layer: "any",
    onClick: (object, event) => {
      const entity = object?.entity || null;
      if (entity && labelByEntity.has(entity)) {
        const parcel = labelByEntity.get(entity);
        if (parcel) {
          markInteractiveClick();
          openPopup(map, parcel, YMapMarker, interactiveEntities);
          return;
        }
      }
      if (nowTs() - lastInteractiveClickAt < 160) return;
      const entityParcel = featureByEntity.get(entity);
      if (entityParcel) {
        markInteractiveClick();
        openPopup(map, entityParcel, YMapMarker, interactiveEntities);
        return;
      }
      const clickedParcel = findParcelByLngLat(features, extractLngLat(object, event) || lastPointerLngLat);
      if (clickedParcel) {
        markInteractiveClick();
        openPopup(map, clickedParcel, YMapMarker, interactiveEntities);
        return;
      }
      if (!entity || !interactiveEntities.has(entity)) {
        closePopup(map, interactiveEntities);
      }
    },
    onMouseMove: (object, event) => {
      const entity = object?.entity || null;
      lastPointerLngLat = extractLngLat(object, event) || lastPointerLngLat;
      const parcel = featureByEntity.get(entity) ||
        labelByEntity.get(entity) ||
        findParcelByLngLat(features, lastPointerLngLat);
      setHoveredParcel(parcel);
    },
  });
  map.addChild(listener);

  document.getElementById("map").addEventListener("click", () => {
    if (nowTs() - lastInteractiveClickAt < 160) return;
    const parcel = hoveredParcel || findParcelByLngLat(features, lastPointerLngLat);
    if (!parcel) {
      closePopup(map, interactiveEntities);
      return;
    }
    markInteractiveClick();
    openPopup(map, parcel, YMapMarker, interactiveEntities);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePopup(map, interactiveEntities);
    }
  });

  features.forEach((parcel) => {
    const rings = getPolygonRings(parcel);
    if (!rings.length) return;
    let mapFeature = null;
    mapFeature = new YMapFeature({
      geometry: { type: "Polygon", coordinates: rings },
      style: getParcelStyle(parcel),
      onClick: () => {
        markInteractiveClick();
        openPopup(map, parcel, YMapMarker, interactiveEntities);
      },
      onMouseEnter: () => setHoveredParcel(parcel),
      onMouseLeave: () => setHoveredParcel(null),
    });
    map.addChild(mapFeature);
    interactiveEntities.add(mapFeature);
    featureByEntity.set(mapFeature, parcel);
    featureByCadnum.set(parcel.properties.cadnum, mapFeature);

    const centerPoint = ringCenter(getOuterRing(parcel));
    if (centerPoint) {
      const labelMarker = new YMapMarker({
        coordinates: centerPoint,
        zIndex: 2200,
        disableRoundCoordinates: true,
      }, createLabelNode(parcel));
      map.addChild(labelMarker);
      labelByEntity.set(labelMarker, parcel);
    }
  });

  setTimeout(() => {
    map.setLocation({ bounds, duration: 0 });
  }, 0);
}

init().catch((error) => {
  console.error(error);
  document.getElementById("map").textContent = `Ошибка запуска карты: ${error.message}`;
});
