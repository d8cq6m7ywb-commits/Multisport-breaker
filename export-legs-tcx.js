// export-legs-tcx.js v3.0
// Convert legs-debug JSON (v3) from the browser tool into enriched TCX files per leg.
// Usage: node export-legs-tcx.js <legs-json-file>
//
// Supports: sport overrides (userSport), lap summary (avg/max HR, power),
// Creator element, Notes, swim handling, distance rebasing.

import fs from "node:fs/promises";
import path from "node:path";

function mapSportToTcx(sport) {
  if (!sport) return "Other";
  const s = sport.toString().toLowerCase();
  if (s.includes("bike") || s.includes("cycling") || s === "biking") return "Biking";
  if (s.includes("run") || s === "running") return "Running";
  return "Other";
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function computeLapSummary(recs) {
  let hrSum = 0, hrCount = 0, hrMax = 0;
  let powerSum = 0, powerCount = 0, powerMax = 0;
  let speedMax = 0;
  let calories = 0;

  recs.forEach(r => {
    const hr = typeof r.heart_rate === "number" ? r.heart_rate :
               typeof r.heartRate === "number" ? r.heartRate : null;
    if (hr != null) { hrSum += hr; hrCount++; if (hr > hrMax) hrMax = hr; }

    const p = typeof r.power === "number" ? r.power : null;
    if (p != null) { powerSum += p; powerCount++; if (p > powerMax) powerMax = p; }

    const s = typeof r.enhanced_speed === "number" ? r.enhanced_speed :
              typeof r.speed === "number" ? r.speed : null;
    if (s != null && s > speedMax) speedMax = s;

    if (typeof r.calories === "number") calories = Math.max(calories, r.calories);
  });

  return {
    avgHr: hrCount > 0 ? Math.round(hrSum / hrCount) : null,
    maxHr: hrMax > 0 ? Math.round(hrMax) : null,
    avgPower: powerCount > 0 ? Math.round(powerSum / powerCount) : null,
    maxPower: powerMax > 0 ? Math.round(powerMax) : null,
    maxSpeed: speedMax > 0 ? speedMax : null,
    calories: calories > 0 ? Math.round(calories) : null,
  };
}

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("Usage: node export-legs-tcx.js <legs-json-file>");
    process.exit(1);
  }

  const absJsonPath = path.resolve(jsonPath);
  console.log("Reading debug JSON from:", absJsonPath);

  const raw = await fs.readFile(absJsonPath, "utf8");
  const data = JSON.parse(raw);

  const legs = data.legs || [];
  if (!Array.isArray(legs) || legs.length === 0) {
    console.error("No legs found in JSON.");
    process.exit(1);
  }

  const outDir = path.join(path.dirname(absJsonPath), "tcx-legs-out");
  await fs.mkdir(outDir, { recursive: true });
  console.log(`Found ${legs.length} leg(s). Writing TCX files to ${outDir}`);

  const baseName = (data.fileName || "multisport").replace(/\.fit$/i, "");
  const version = data.version || "2.0";
  const deviceInfo = data.diagnostics?.device || null;

  for (const leg of legs) {
    const recs = leg.records || [];
    if (!recs.length) {
      console.warn(`Leg ${leg.index}: no records, skipping.`);
      continue;
    }

    // Use userSport override if present (v3 feature)
    const effectiveSport = leg.effectiveSport || leg.userSport || leg.sport;
    const sportAttr = mapSportToTcx(effectiveSport);
    const startTimeIso = leg.start || recs[0].timestamp;
    const endTimeIso = leg.end || recs[recs.length - 1].timestamp;

    const startTime = new Date(startTimeIso);
    const endTime = new Date(endTimeIso);
    const totalTimeSec =
      leg.durationSec && Number.isFinite(leg.durationSec)
        ? leg.durationSec
        : (endTime - startTime) / 1000;

    // Rebase distance
    let distOffset = null;
    let totalDistMeters = 0;

    // Lap summary
    const summary = computeLapSummary(recs);

    const trackpoints = recs
      .map((r) => {
        const tIso = r.timestamp;
        if (!tIso) return null;

        const lat = r.position_lat ?? r.positionLat ?? null;
        const lon = r.position_long ?? r.positionLong ?? null;
        const altitude = r.enhanced_altitude ?? r.altitude ?? r.enhancedAltitude ?? null;

        let dist = typeof r.distance === "number" ? r.distance :
                   typeof r.enhanced_distance === "number" ? r.enhanced_distance : null;

        if (dist != null) {
          if (distOffset === null) distOffset = dist;
          dist = dist - distOffset;
          if (dist < 0) dist = 0;
          totalDistMeters = dist;
        }

        const hr = typeof r.heart_rate === "number" ? r.heart_rate :
                   typeof r.heartRate === "number" ? r.heartRate : null;
        const cad = typeof r.cadence === "number" ? r.cadence :
                    typeof r.cadence_sensor === "number" ? r.cadence_sensor : null;
        const power = typeof r.power === "number" ? r.power : null;
        const speedMs = typeof r.enhanced_speed === "number" ? r.enhanced_speed :
                        typeof r.speed === "number" ? r.speed : null;

        let xml = `        <Trackpoint>\n`;
        xml += `          <Time>${xmlEscape(tIso)}</Time>\n`;

        if (lat != null && lon != null) {
          xml += `          <Position>\n`;
          xml += `            <LatitudeDegrees>${lat}</LatitudeDegrees>\n`;
          xml += `            <LongitudeDegrees>${lon}</LongitudeDegrees>\n`;
          xml += `          </Position>\n`;
        }
        if (altitude != null) xml += `          <AltitudeMeters>${Number(altitude).toFixed(1)}</AltitudeMeters>\n`;
        if (dist != null) xml += `          <DistanceMeters>${dist.toFixed(1)}</DistanceMeters>\n`;
        if (hr != null) {
          xml += `          <HeartRateBpm>\n`;
          xml += `            <Value>${Math.round(hr)}</Value>\n`;
          xml += `          </HeartRateBpm>\n`;
        }
        if (cad != null) xml += `          <Cadence>${Math.round(cad)}</Cadence>\n`;

        if (speedMs != null || power != null) {
          xml += `          <Extensions>\n`;
          xml += `            <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">\n`;
          if (speedMs != null) xml += `              <Speed>${speedMs.toFixed(3)}</Speed>\n`;
          if (power != null) xml += `              <Watts>${Math.round(power)}</Watts>\n`;
          xml += `            </TPX>\n`;
          xml += `          </Extensions>\n`;
        }

        xml += `        </Trackpoint>\n`;
        return xml;
      })
      .filter(Boolean)
      .join("");

    // Lap summary XML
    let lapSummaryXml = "";
    if (summary.avgHr != null) {
      lapSummaryXml += `        <AverageHeartRateBpm><Value>${summary.avgHr}</Value></AverageHeartRateBpm>\n`;
    }
    if (summary.maxHr != null) {
      lapSummaryXml += `        <MaximumHeartRateBpm><Value>${summary.maxHr}</Value></MaximumHeartRateBpm>\n`;
    }
    if (summary.maxSpeed != null) {
      lapSummaryXml += `        <MaximumSpeed>${summary.maxSpeed.toFixed(3)}</MaximumSpeed>\n`;
    }
    if (summary.calories != null) {
      lapSummaryXml += `        <Calories>${summary.calories}</Calories>\n`;
    }

    // Lap extensions for power
    let lapExtXml = "";
    if (summary.avgPower != null || summary.maxPower != null) {
      lapExtXml += "        <Extensions>\n          <LX xmlns=\"http://www.garmin.com/xmlschemas/ActivityExtension/v2\">\n";
      if (summary.avgPower != null) lapExtXml += `            <AvgWatts>${summary.avgPower}</AvgWatts>\n`;
      if (summary.maxPower != null) lapExtXml += `            <MaxWatts>${summary.maxPower}</MaxWatts>\n`;
      lapExtXml += "          </LX>\n        </Extensions>\n";
    }

    // Creator element
    let creatorXml = "";
    if (deviceInfo) {
      creatorXml += `      <Creator xsi:type="Device_t">\n`;
      creatorXml += `        <Name>${xmlEscape(deviceInfo)}</Name>\n`;
      creatorXml += `      </Creator>\n`;
    }

    // Notes
    const detSource = leg.detectionSource || "unknown";
    const conf = leg.confidence || 0;
    const notes = `Leg ${leg.index}: ${effectiveSport}. Detection: ${detSource}. Confidence: ${conf}%.`;

    const tcx = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:ns2="http://www.garmin.com/xmlschemas/UserProfile/v2"
  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"
  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2
  http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">
  <Activities>
    <Activity Sport="${sportAttr}">
      <Id>${xmlEscape(startTime.toISOString())}</Id>
      <Lap StartTime="${xmlEscape(startTime.toISOString())}">
        <TotalTimeSeconds>${totalTimeSec.toFixed(1)}</TotalTimeSeconds>
        <DistanceMeters>${totalDistMeters.toFixed(1)}</DistanceMeters>
${lapSummaryXml}        <Intensity>Active</Intensity>
        <TriggerMethod>Manual</TriggerMethod>
${lapExtXml}        <Track>
${trackpoints}        </Track>
      </Lap>
      <Notes>${xmlEscape(notes)}</Notes>
${creatorXml}    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;

    const outName = `${baseName}.leg-${leg.index}.tcx`;
    const outPath = path.join(outDir, outName);
    await fs.writeFile(outPath, tcx, "utf8");

    const sportLabel = leg.userSport ? `${effectiveSport} (override)` : effectiveSport;
    console.log(
      `Wrote leg ${leg.index} → ${outPath} (${sportLabel}, ${sportAttr}, records: ${recs.length}, dist: ${totalDistMeters.toFixed(0)}m, conf: ${conf}%)`
    );
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error in export-legs-tcx.js:", err);
  process.exit(1);
});
