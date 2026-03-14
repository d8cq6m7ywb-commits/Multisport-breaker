// multisport-breaker.js v3.0
// Multisport FIT Splitter — parse, detect legs (4-layer cascade), draggable boundaries,
// diagnostics, swim handling, sport relabeling, timeline bar, TCX + FIT export.
// Yousuli Lab — All 13 improvements implemented.

(function () {
  "use strict";

  // ============ DOM refs ============
  const fileInput = document.getElementById("fitFile");
  const statusEl = document.getElementById("status");
  const sessionTableBody = document.getElementById("sessionTableBody");
  const legTableBody = document.getElementById("legTableBody");
  const chartCanvas = document.getElementById("mainChart");
  const routeMapDiv = document.getElementById("routeMap");
  const downloadJsonBtn = document.getElementById("downloadJsonBtn");
  const downloadTcxBtn = document.getElementById("downloadTcxBtn");
  const downloadAllTcxBtn = document.getElementById("downloadAllTcxBtn");
  const downloadAllFitBtn = document.getElementById("downloadAllFitBtn");
  const exportStatusEl = document.getElementById("exportStatus");
  const diagnosticsPanel = document.getElementById("diagnosticsPanel");
  const fileSizeWarning = document.getElementById("fileSizeWarning");
  const timelineBarEl = document.getElementById("timelineBar");
  const downsampleIndicator = document.getElementById("downsampleIndicator");

  // ============ State ============
  const state = {
    fileName: null,
    rawData: null,
    sessions: [],
    records: [],
    legs: [],
    boundaries: [],
    t0: null,
    tEnd: null,
    chart: null,
    chartT0Ms: null,
    drag: { active: false, boundaryIndex: null },
    timelineDrag: { active: false, boundaryIndex: null },
    interactionsSetup: false,
    map: null,
    mapLayers: [],
    mapBuilt: false,
    activeLegIndex: null,
    fitParserReady: typeof FitParser !== "undefined",
    // New state fields
    diagnostics: null,
    detectionMethod: null,
    events: [],
    laps: [],
    fileId: null,
    swimFields: {},
    dataWarnings: [],
  };

  // Expose state for console debugging
  window._msbState = state;

  if (!fileInput) { console.error("File input #fitFile not found"); return; }

  fileInput.addEventListener("change", handleFileSelect);
  if (downloadJsonBtn) downloadJsonBtn.addEventListener("click", handleDownloadJson);
  if (downloadTcxBtn) downloadTcxBtn.addEventListener("click", handleDownloadTcx);
  if (downloadAllTcxBtn) downloadAllTcxBtn.addEventListener("click", handleDownloadAllTcx);
  if (downloadAllFitBtn) downloadAllFitBtn.addEventListener("click", handleDownloadAllFit);

  // Wait for FitParser module
  if (!state.fitParserReady) {
    window.addEventListener("fitparser-ready", function () {
      state.fitParserReady = true;
      console.log("[MSB] FitParser module loaded.");
    });
  }

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
    console.log("[MSB]", msg);
  }
  function setExportStatus(msg) {
    if (exportStatusEl) exportStatusEl.textContent = msg || "";
  }

  // ============ LEG COLORS ============
  const LEG_COLORS = [
    "#4ac6ff", "#ff6b9c", "#7af0b8", "#ffc857", "#c084fc",
    "#ff8a4c", "#67e8f9", "#a3e635", "#f472b6", "#facc15",
  ];

  // ============ #12: FIT VALIDATION ============

  function validateFitFile(arrayBuffer) {
    const errors = [];
    if (arrayBuffer.byteLength < 14) {
      errors.push("File too small to be a valid FIT file (< 14 bytes).");
      return { valid: false, errors };
    }
    const view = new DataView(arrayBuffer);
    // Check header size (byte 0) should be 12 or 14
    const headerSize = view.getUint8(0);
    if (headerSize !== 12 && headerSize !== 14) {
      errors.push(`Unexpected FIT header size: ${headerSize} (expected 12 or 14).`);
    }
    // Check ".FIT" signature at bytes 8-11
    const sig = String.fromCharCode(
      view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)
    );
    if (sig !== ".FIT") {
      errors.push(`Missing .FIT signature (found "${sig}"). This may not be a FIT file.`);
    }
    // Check data size
    const dataSize = view.getUint32(4, true); // little-endian
    const expectedMin = headerSize + dataSize;
    if (arrayBuffer.byteLength < expectedMin) {
      errors.push(`File appears truncated: expected at least ${expectedMin} bytes but got ${arrayBuffer.byteLength}.`);
    }
    return { valid: errors.length === 0, errors };
  }

  // ============ FILE LOAD & PARSE ============

  function handleFileSelect(evt) {
    const file = evt.target.files[0];
    if (!file) { setStatus("No file selected."); return; }
    if (!file.name.toLowerCase().endsWith(".fit")) {
      setStatus("Selected file does not look like a .fit file.");
      return;
    }

    // #13: File size warning
    if (fileSizeWarning) {
      if (file.size > 5 * 1024 * 1024) {
        fileSizeWarning.textContent = `Large file detected (${(file.size / 1024 / 1024).toFixed(1)} MB). Parsing may take a moment.`;
        fileSizeWarning.style.display = "block";
      } else {
        fileSizeWarning.style.display = "none";
      }
    }

    setStatus(`Loading file "${file.name}"...`);
    setExportStatus("");

    const reader = new FileReader();
    reader.onload = function (e) {
      const arrayBuffer = e.target.result;
      if (!state.fitParserReady) {
        setStatus("Waiting for FIT parser to load...");
        window.addEventListener("fitparser-ready", function () {
          parseAndDisplay(arrayBuffer, file.name);
        }, { once: true });
      } else {
        parseAndDisplay(arrayBuffer, file.name);
      }
    };
    reader.onerror = function () { setStatus("Error reading file."); };
    reader.readAsArrayBuffer(file);
  }

  function parseAndDisplay(arrayBuffer, fileName) {
    setStatus("Parsing FIT file...");

    // #12: Validate FIT file structure
    const validation = validateFitFile(arrayBuffer);
    if (!validation.valid) {
      const errMsg = validation.errors.join(" ");
      setStatus("FIT validation warning: " + errMsg + " Attempting parse anyway...");
      console.warn("[MSB] FIT validation issues:", validation.errors);
    }

    if (typeof FitParser === "undefined") {
      setStatus("Internal error: FitParser not loaded. Try refreshing the page.");
      return;
    }

    // #13: Cleanup before reparse
    cleanupBeforeReparse();

    const fitParser = new FitParser({
      force: true,
      speedUnit: "m/s",
      lengthUnit: "m",
      temperatureUnit: "celsius",
      elapsedRecordField: true,
      mode: "list",
    });

    try {
      fitParser.parse(arrayBuffer, function (error, data) {
        if (error) {
          console.error("FIT parse error:", error);
          setStatus("Error while parsing FIT file: " + String(error));
          return;
        }

        try {
          processParseResult(data, fileName);
        } catch (err) {
          console.error("[MSB] Error processing parsed data:", err);
          setStatus("Error processing FIT data: " + err.message);
        }
      });
    } catch (err) {
      console.error("[MSB] FIT parser threw:", err);
      setStatus("FIT parser error: " + err.message);
    }
  }

  function processParseResult(data, fileName) {
    console.log("Parsed FIT data:", data);

    const sessions = data.session || data.sessions || [];
    const records = data.record || data.records || [];
    const events = data.event || data.events || [];
    const laps = data.lap || data.laps || [];
    const fileId = (data.file_id || data.fileId || [])[0] || null;

    state.fileName = fileName;
    state.rawData = data;
    state.sessions = sessions;
    state.records = records;
    state.events = events;
    state.laps = laps;
    state.fileId = fileId;
    state.activeLegIndex = null;
    state.mapBuilt = false;

    // #10: Sanitize records
    const sanitizeResult = sanitizeRecords(records);
    state.dataWarnings = sanitizeResult.warnings;

    // #8: Detect swim fields
    state.swimFields = detectSwimFields(records);

    // #3: Build diagnostics
    state.diagnostics = buildDiagnostics(data, records, sessions, laps, events, fileId);
    renderDiagnosticsPanel();

    // #13: Record count warning
    if (records.length > 50000 && fileSizeWarning) {
      fileSizeWarning.textContent = `Large dataset: ${records.length.toLocaleString()} records. Chart is downsampled for performance.`;
      fileSizeWarning.style.display = "block";
    }

    setStatus(
      `Parsed "${fileName}". Found ${sessions.length} session(s), ${laps.length} lap(s), ${events.length} event(s), ${records.length} record(s).`
    );

    renderSessionTable(sessions);
    buildLegsAndBoundaries();
    renderLegTable();
    renderTimelineBar();
    buildMainChart();
    setupLazyMap();
    setupChartInteractions();
    setupTimelineDrag();
    setExportStatus("");
  }

  // ============ #13: CLEANUP ============

  function cleanupBeforeReparse() {
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    if (state.map) { state.map.remove(); state.map = null; }
    state.mapLayers = [];
    state.mapBuilt = false;
    state.legs = [];
    state.boundaries = [];
    state.diagnostics = null;
    state.dataWarnings = [];
    state.swimFields = {};
    state.detectionMethod = null;
    if (timelineBarEl) timelineBarEl.innerHTML = "";
  }

  // ============ #3: DIAGNOSTICS ============

  function buildDiagnostics(data, records, sessions, laps, events, fileId) {
    const diag = {
      device: "Unknown",
      manufacturer: "",
      sessionCount: sessions.length,
      lapCount: laps.length,
      eventCount: events.length,
      recordCount: records.length,
      fields: {},
      anomalies: [],
      totalDuration: 0,
      totalDistance: 0,
    };

    // Device info
    if (fileId) {
      const mfr = fileId.manufacturer || fileId.garmin_product || "";
      const prod = fileId.product_name || fileId.product || fileId.garmin_product || "";
      const serial = fileId.serial_number || "";
      diag.manufacturer = String(mfr);
      diag.device = [String(mfr), String(prod), serial ? `(S/N: ${serial})` : ""].filter(Boolean).join(" ");
    }

    // Field presence scan (sample up to 500 records for speed)
    const sampleSize = Math.min(records.length, 500);
    const step = Math.max(1, Math.floor(records.length / sampleSize));
    const fieldCounts = {};
    const fieldNames = [
      "power", "heart_rate", "heartRate", "cadence", "speed", "enhanced_speed",
      "position_lat", "position_long", "altitude", "enhanced_altitude",
      "temperature", "distance", "enhanced_distance",
      "stroke_count", "pool_length", "swolf", "num_lengths", "swim_stroke", "total_strokes",
    ];
    fieldNames.forEach(f => fieldCounts[f] = 0);

    for (let i = 0; i < records.length; i += step) {
      const r = records[i];
      fieldNames.forEach(f => {
        if (typeof r[f] === "number") fieldCounts[f]++;
      });
    }

    const present = [];
    if (fieldCounts.power > 0) present.push("Power");
    if (fieldCounts.heart_rate > 0 || fieldCounts.heartRate > 0) present.push("HR");
    if (fieldCounts.cadence > 0) present.push("Cadence");
    if (fieldCounts.speed > 0 || fieldCounts.enhanced_speed > 0) present.push("Speed");
    if (fieldCounts.position_lat > 0) present.push("GPS");
    if (fieldCounts.altitude > 0 || fieldCounts.enhanced_altitude > 0) present.push("Altitude");
    if (fieldCounts.temperature > 0) present.push("Temp");
    if (fieldCounts.distance > 0 || fieldCounts.enhanced_distance > 0) present.push("Distance");
    if (fieldCounts.stroke_count > 0 || fieldCounts.total_strokes > 0) present.push("Swim strokes");
    if (fieldCounts.swolf > 0) present.push("SWOLF");
    diag.fields = { present, counts: fieldCounts };

    // Total duration and distance from sessions
    sessions.forEach(s => {
      const dur = typeof s.total_elapsed_time === "number" ? s.total_elapsed_time :
                  typeof s.total_timer_time === "number" ? s.total_timer_time : 0;
      diag.totalDuration += dur;
      const dist = typeof s.total_distance === "number" ? s.total_distance : 0;
      diag.totalDistance += dist;
    });

    // Anomaly detection
    if (records.length > 1) {
      let gapCount = 0;
      let maxGap = 0;
      for (let i = 1; i < records.length; i++) {
        const t1 = getTimeMs(records[i - 1].timestamp);
        const t2 = getTimeMs(records[i].timestamp);
        if (isFinite(t1) && isFinite(t2)) {
          const gap = (t2 - t1) / 1000;
          if (gap > 60) { gapCount++; if (gap > maxGap) maxGap = gap; }
        }
      }
      if (gapCount > 0) {
        diag.anomalies.push(`${gapCount} timestamp gap(s) > 60s (max ${formatDuration(maxGap)})`);
      }
    }

    // Check for overlapping sessions
    for (let i = 0; i < sessions.length - 1; i++) {
      const s1End = getTimeMs(sessions[i].start_time || sessions[i].timestamp) +
        ((sessions[i].total_elapsed_time || 0) * 1000);
      const s2Start = getTimeMs(sessions[i + 1].start_time || sessions[i + 1].timestamp);
      if (isFinite(s1End) && isFinite(s2Start) && s1End > s2Start + 1000) {
        diag.anomalies.push("Overlapping sessions detected.");
        break;
      }
    }

    // Check for null timestamps
    const nullTs = records.filter(r => !isFinite(getTimeMs(r.timestamp))).length;
    if (nullTs > 0) {
      diag.anomalies.push(`${nullTs} record(s) with missing/invalid timestamps.`);
    }

    return diag;
  }

  function renderDiagnosticsPanel() {
    if (!diagnosticsPanel || !state.diagnostics) return;
    const d = state.diagnostics;

    diagnosticsPanel.style.display = "grid";

    const setVal = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    setVal("diagDeviceValue", d.device || "Unknown");
    setVal("diagDetectionValue", state.detectionMethod || "pending...");
    setVal("diagCountsValue",
      `${d.sessionCount} sessions, ${d.lapCount} laps, ${d.eventCount} events, ${d.recordCount} records`
    );
    setVal("diagFieldsValue", (d.fields.present || []).join(", ") || "None detected");
    setVal("diagDurationValue",
      `${formatDuration(d.totalDuration)} / ${(d.totalDistance / 1000).toFixed(2)} km`
    );

    const warningsEl = document.getElementById("diagWarnings");
    const warningsValEl = document.getElementById("diagWarningsValue");
    const allWarnings = (d.anomalies || []).concat(state.dataWarnings || []);
    if (allWarnings.length > 0 && warningsEl && warningsValEl) {
      warningsEl.style.display = "block";
      warningsValEl.textContent = allWarnings.join(" | ");
    } else if (warningsEl) {
      warningsEl.style.display = "none";
    }
  }

  // ============ #10: DATA SANITIZATION ============

  function sanitizeRecords(records) {
    const warnings = [];
    if (!records.length) return { records, warnings };

    let distDecreaseCount = 0;
    let gapCount = 0;

    for (let i = 1; i < records.length; i++) {
      const prev = records[i - 1];
      const curr = records[i];

      // Distance monotonicity
      const prevDist = typeof prev.distance === "number" ? prev.distance :
                       typeof prev.enhanced_distance === "number" ? prev.enhanced_distance : null;
      const currDist = typeof curr.distance === "number" ? curr.distance :
                       typeof curr.enhanced_distance === "number" ? curr.enhanced_distance : null;
      if (prevDist != null && currDist != null && currDist < prevDist - 0.5) {
        distDecreaseCount++;
      }

      // Timestamp gaps > 30s
      const t1 = getTimeMs(prev.timestamp);
      const t2 = getTimeMs(curr.timestamp);
      if (isFinite(t1) && isFinite(t2) && (t2 - t1) > 30000) {
        gapCount++;
      }
    }

    if (distDecreaseCount > 0) {
      warnings.push(`Distance decreased ${distDecreaseCount} time(s) — possible sensor reset.`);
    }
    if (gapCount > 5) {
      warnings.push(`${gapCount} recording gaps > 30s — autopause or signal loss.`);
    }

    return { records, warnings };
  }

  // ============ #8: SWIM HANDLING ============

  function detectSwimFields(records) {
    const fields = {};
    const swimKeys = ["stroke_count", "pool_length", "swolf", "num_lengths", "swim_stroke", "total_strokes"];
    const sampleSize = Math.min(records.length, 1000);
    const step = Math.max(1, Math.floor(records.length / sampleSize));

    for (let i = 0; i < records.length; i += step) {
      const r = records[i];
      swimKeys.forEach(k => {
        if (typeof r[k] === "number" && r[k] > 0) fields[k] = true;
      });
    }
    return fields;
  }

  function computeSwimMetrics(leg, recs) {
    const metrics = { totalStrokes: 0, avgSwolf: null, poolLength: null };
    let swolfSum = 0, swolfCount = 0;

    recs.forEach(r => {
      if (typeof r.stroke_count === "number") metrics.totalStrokes += r.stroke_count;
      if (typeof r.total_strokes === "number") metrics.totalStrokes = Math.max(metrics.totalStrokes, r.total_strokes);
      if (typeof r.swolf === "number") { swolfSum += r.swolf; swolfCount++; }
      if (typeof r.pool_length === "number" && r.pool_length > 0) metrics.poolLength = r.pool_length;
    });

    if (swolfCount > 0) metrics.avgSwolf = (swolfSum / swolfCount).toFixed(1);
    return metrics;
  }

  // ============ SESSION TABLE ============

  function renderSessionTable(sessions) {
    sessionTableBody.innerHTML = "";

    if (!sessions || sessions.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.textContent = "No session messages found in file.";
      tr.appendChild(td);
      sessionTableBody.appendChild(tr);
      return;
    }

    sessions
      .map((s, idx) => ({ index: idx, session: s }))
      .sort((a, b) => {
        const ta = getTimeMs(a.session.start_time || a.session.timestamp || 0);
        const tb = getTimeMs(b.session.start_time || b.session.timestamp || 0);
        return ta - tb;
      })
      .forEach(({ index, session }) => {
        const tr = document.createElement("tr");
        const startDate = normalizeDate(session.start_time || session.timestamp);
        let elapsedSec = typeof session.total_elapsed_time === "number" ? session.total_elapsed_time :
                         typeof session.total_timer_time === "number" ? session.total_timer_time : null;
        const endDate = startDate && typeof elapsedSec === "number"
          ? new Date(startDate.getTime() + elapsedSec * 1000) : null;
        const sport = session.sport !== undefined ? String(session.sport) : "(unknown)";
        const subsport = session.sub_sport !== undefined ? String(session.sub_sport) : "";

        addCell(tr, index + 1);
        addCell(tr, sport);
        addCell(tr, subsport);
        addCell(tr, startDate ? formatDateTime(startDate) : "");
        addCell(tr, endDate ? formatDateTime(endDate) : "");
        addCell(tr, elapsedSec != null ? formatDuration(elapsedSec) : "");
        sessionTableBody.appendChild(tr);
      });
  }

  // ============ #1: LEG DETECTION CASCADE ============

  function buildLegsAndBoundaries() {
    const sessions = state.sessions || [];
    const records = state.records || [];
    const events = state.events || [];
    const laps = state.laps || [];

    state.legs = [];
    state.boundaries = [];
    state.t0 = null;
    state.tEnd = null;

    if (!records.length) return;

    let legs = [];
    let method = "none";

    // Layer 1: Sessions (if >= 2)
    if (sessions.length >= 2) {
      legs = detectLegsFromSessions(sessions);
      method = "sessions";
    }

    // Layer 2: Events with sport changes
    if (legs.length < 2) {
      const eventLegs = detectLegsFromEvents(events, records);
      if (eventLegs.length >= 2) {
        legs = eventLegs;
        method = "events";
      }
    }

    // Layer 3: Laps with sport fields
    if (legs.length < 2) {
      const lapLegs = detectLegsFromLaps(laps);
      if (lapLegs.length >= 2) {
        legs = lapLegs;
        method = "laps";
      }
    }

    // Layer 4: Signal-based heuristics
    if (legs.length < 2) {
      const heuristicLegs = detectLegsFromSignals(records);
      if (heuristicLegs.length >= 1) {
        legs = heuristicLegs;
        method = "heuristic";
      }
    }

    // Single session fallback
    if (legs.length === 0 && sessions.length === 1) {
      legs = detectLegsFromSessions(sessions);
      method = "single-session";
    }

    // Absolute fallback: make one leg from all records
    if (legs.length === 0 && records.length > 0) {
      const first = normalizeDate(records[0].timestamp);
      const last = normalizeDate(records[records.length - 1].timestamp);
      if (first && last) {
        legs = [{
          index: 1, sport: "unknown", subsport: "", isTransition: false,
          start: first, end: last,
          durationSec: (last.getTime() - first.getTime()) / 1000,
          hasExplicitSport: false, hasExplicitDuration: false,
          detectionSource: "fallback", userSport: null,
        }];
        method = "fallback";
      }
    }

    state.detectionMethod = method;
    state.legs = legs;
    if (!legs.length) return;

    state.t0 = legs[0].start;
    state.tEnd = legs[legs.length - 1].end;

    // Build boundaries
    const boundaries = [];
    for (let i = 0; i < legs.length - 1; i++) {
      const a = legs[i];
      const b = legs[i + 1];
      const midMs = (a.end.getTime() + b.start.getTime()) / 2;
      boundaries.push({ index: i, time: new Date(midMs), leftLeg: i, rightLeg: i + 1 });
    }
    state.boundaries = boundaries;

    updateLegsFromBoundaries();

    // #5: Infer transitions
    inferTransitions();

    computeConfidence();

    // Update diagnostics detection method
    if (diagnosticsPanel) {
      const el = document.getElementById("diagDetectionValue");
      if (el) el.textContent = method + ` (${legs.length} legs)`;
    }
  }

  // Layer 1: Session-based detection (original behavior)
  function detectLegsFromSessions(sessions) {
    return sessions
      .map((s, idx) => {
        const start = normalizeDate(s.start_time || s.timestamp || 0);
        const durSec = typeof s.total_elapsed_time === "number" ? s.total_elapsed_time :
                       typeof s.total_timer_time === "number" ? s.total_timer_time : 0;
        const end = start ? new Date(start.getTime() + durSec * 1000) : null;
        const sport = (s.sport || "").toString();
        const subsport = (s.sub_sport || "").toString();

        return {
          index: idx + 1,
          sport,
          subsport,
          isTransition: sport.toLowerCase() === "transition",
          start, end,
          durationSec: durSec,
          hasExplicitSport: s.sport !== undefined && s.sport !== null,
          hasExplicitDuration: typeof s.total_elapsed_time === "number",
          detectionSource: "session",
          userSport: null,
        };
      })
      .filter(leg => leg.start && leg.end)
      .sort((a, b) => a.start - b.start);
  }

  // Layer 2: Event-based detection
  function detectLegsFromEvents(events, records) {
    // Look for sport change events
    const sportEvents = events.filter(e =>
      e.event === "sport" || e.event_type === "sport" ||
      (e.data && typeof e.data === "object" && e.data.sport !== undefined)
    );

    if (sportEvents.length < 2) return [];

    const sorted = sportEvents
      .map(e => ({
        time: normalizeDate(e.timestamp),
        sport: String(e.sport || (e.data && e.data.sport) || "unknown"),
        subsport: String(e.sub_sport || (e.data && e.data.sub_sport) || ""),
      }))
      .filter(e => e.time)
      .sort((a, b) => a.time - b.time);

    if (sorted.length < 2) return [];

    const legs = [];
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i].time;
      const end = i < sorted.length - 1 ? sorted[i + 1].time :
        records.length > 0 ? normalizeDate(records[records.length - 1].timestamp) : new Date(start.getTime() + 60000);

      if (!end) continue;

      legs.push({
        index: i + 1,
        sport: sorted[i].sport,
        subsport: sorted[i].subsport,
        isTransition: sorted[i].sport.toLowerCase() === "transition",
        start, end,
        durationSec: (end.getTime() - start.getTime()) / 1000,
        hasExplicitSport: true,
        hasExplicitDuration: false,
        detectionSource: "event",
        userSport: null,
      });
    }
    return legs;
  }

  // Layer 3: Lap-based detection
  function detectLegsFromLaps(laps) {
    if (!laps.length) return [];

    // Sort laps chronologically
    const sorted = laps
      .map(l => ({
        start: normalizeDate(l.start_time || l.timestamp),
        sport: (l.sport || "").toString(),
        subsport: (l.sub_sport || "").toString(),
        duration: typeof l.total_elapsed_time === "number" ? l.total_elapsed_time :
                  typeof l.total_timer_time === "number" ? l.total_timer_time : 0,
      }))
      .filter(l => l.start)
      .sort((a, b) => a.start - b.start);

    if (sorted.length === 0) return [];

    // Merge consecutive laps of the same sport
    const merged = [];
    let current = { ...sorted[0], end: new Date(sorted[0].start.getTime() + sorted[0].duration * 1000) };

    for (let i = 1; i < sorted.length; i++) {
      const lap = sorted[i];
      const lapEnd = new Date(lap.start.getTime() + lap.duration * 1000);

      if (lap.sport === current.sport && lap.sport !== "") {
        // Same sport: extend current leg
        current.end = lapEnd;
        current.duration += lap.duration;
      } else {
        merged.push(current);
        current = { ...lap, end: lapEnd };
      }
    }
    merged.push(current);

    // Only useful if we got multiple distinct sport groups
    const distinctSports = new Set(merged.map(m => m.sport).filter(Boolean));
    if (distinctSports.size < 2 && merged.length < 2) return [];

    return merged.map((m, idx) => ({
      index: idx + 1,
      sport: m.sport || "unknown",
      subsport: m.subsport || "",
      isTransition: m.sport.toLowerCase() === "transition",
      start: m.start,
      end: m.end,
      durationSec: m.duration,
      hasExplicitSport: m.sport !== "",
      hasExplicitDuration: true,
      detectionSource: "lap",
      userSport: null,
    }));
  }

  // Layer 4: Signal-based heuristic detection
  function detectLegsFromSignals(records) {
    if (records.length < 60) return []; // Need at least ~1 min of data

    const WINDOW_SIZE = 30; // seconds
    const MIN_SEGMENT_DURATION = 60; // seconds

    // Build time-indexed signal summary
    const points = records
      .map(r => {
        const t = getTimeMs(r.timestamp);
        if (!isFinite(t)) return null;
        const speed = typeof r.enhanced_speed === "number" ? r.enhanced_speed :
                      typeof r.speed === "number" ? r.speed : null;
        const power = typeof r.power === "number" ? r.power : null;
        const cadence = typeof r.cadence === "number" ? r.cadence : null;
        const hasGPS = typeof r.position_lat === "number" && typeof r.position_long === "number";
        return { t, speed, power, cadence, hasGPS };
      })
      .filter(Boolean)
      .sort((a, b) => a.t - b.t);

    if (points.length < 30) return [];

    // Classify each point into a probable sport
    const classified = points.map(p => {
      let sport = "unknown";

      if (p.speed !== null) {
        if (p.power !== null && p.power > 0 && p.speed > 3) {
          sport = "cycling"; // Has power + reasonable speed = bike
        } else if (p.speed > 4.5 && p.cadence !== null && p.cadence > 50 && !p.power) {
          sport = "cycling"; // Fast + cadence + no power = bike (no PM)
        } else if (p.speed >= 1.5 && p.speed <= 6 && p.cadence !== null && p.cadence > 120) {
          sport = "running"; // Moderate speed + high cadence = run
        } else if (p.speed >= 1.5 && p.speed <= 6 && !p.power) {
          sport = "running"; // Moderate speed, no power = probably run
        } else if (p.speed < 1.0) {
          sport = "transition"; // Very slow = transition
        } else if (p.speed < 1.5 && !p.hasGPS) {
          sport = "swimming"; // Slow/no GPS could be swim
        }
      } else if (p.power !== null && p.power > 0) {
        sport = "cycling"; // Power without speed = indoor bike
      }

      return { ...p, sport };
    });

    // Smooth: sliding window majority vote
    const smoothed = classified.map((p, i) => {
      const windowStart = Math.max(0, i - 15);
      const windowEnd = Math.min(classified.length - 1, i + 15);
      const votes = {};
      for (let j = windowStart; j <= windowEnd; j++) {
        const s = classified[j].sport;
        votes[s] = (votes[s] || 0) + 1;
      }
      let best = p.sport, bestCount = 0;
      for (const [s, c] of Object.entries(votes)) {
        if (c > bestCount && s !== "unknown") { best = s; bestCount = c; }
      }
      return { ...p, sport: best };
    });

    // Segment: find contiguous runs of same sport
    const segments = [];
    let currentSport = smoothed[0].sport;
    let segStart = smoothed[0].t;

    for (let i = 1; i < smoothed.length; i++) {
      if (smoothed[i].sport !== currentSport) {
        segments.push({ sport: currentSport, start: segStart, end: smoothed[i - 1].t });
        currentSport = smoothed[i].sport;
        segStart = smoothed[i].t;
      }
    }
    segments.push({ sport: currentSport, start: segStart, end: smoothed[smoothed.length - 1].t });

    // Merge short segments (< MIN_SEGMENT_DURATION) into neighbors
    const merged = [];
    for (const seg of segments) {
      const dur = (seg.end - seg.start) / 1000;
      if (dur < MIN_SEGMENT_DURATION && merged.length > 0) {
        // Absorb into previous
        merged[merged.length - 1].end = seg.end;
      } else {
        merged.push({ ...seg });
      }
    }

    // Filter out trivially short segments
    const filtered = merged.filter(s => (s.end - s.start) / 1000 >= 30);

    if (filtered.length === 0) return [];

    return filtered.map((seg, idx) => ({
      index: idx + 1,
      sport: seg.sport,
      subsport: "",
      isTransition: seg.sport === "transition",
      start: new Date(seg.start),
      end: new Date(seg.end),
      durationSec: (seg.end - seg.start) / 1000,
      hasExplicitSport: false,
      hasExplicitDuration: false,
      detectionSource: "heuristic",
      userSport: null,
    }));
  }

  // ============ #5: TRANSITION INFERENCE ============

  function inferTransitions() {
    const legs = state.legs;
    const records = state.records;
    if (legs.length < 2 || !records.length) return;

    const newLegs = [];
    for (let i = 0; i < legs.length; i++) {
      newLegs.push(legs[i]);

      if (i < legs.length - 1) {
        const currentEnd = legs[i].end;
        const nextStart = legs[i + 1].start;
        const gapMs = nextStart.getTime() - currentEnd.getTime();

        // Only look for transitions if there's a meaningful gap
        if (gapMs > 10000) { // > 10 seconds
          // Check if there are records in this gap with low speed
          const gapRecs = records.filter(r => {
            const t = getTimeMs(r.timestamp);
            return isFinite(t) && t >= currentEnd.getTime() && t <= nextStart.getTime();
          });

          if (gapRecs.length > 0) {
            const avgSpeed = gapRecs.reduce((sum, r) => {
              const s = typeof r.enhanced_speed === "number" ? r.enhanced_speed :
                        typeof r.speed === "number" ? r.speed : 0;
              return sum + s;
            }, 0) / gapRecs.length;

            if (avgSpeed < 2.0 && gapMs > 20000) {
              // Insert transition leg
              const transLeg = {
                index: 0, // Will be renumbered
                sport: "transition",
                subsport: "inferred",
                isTransition: true,
                start: currentEnd,
                end: nextStart,
                durationSec: gapMs / 1000,
                hasExplicitSport: false,
                hasExplicitDuration: false,
                detectionSource: "transition-inferred",
                userSport: null,
              };
              newLegs.push(transLeg);
            }
          }
        }

        // Also check: if current leg doesn't end with transition and
        // there's a speed drop zone at the end
        if (!legs[i].isTransition && !legs[i + 1].isTransition && gapMs <= 10000) {
          // Check for speed drop zone at boundary
          const boundaryTime = (currentEnd.getTime() + nextStart.getTime()) / 2;
          const nearRecs = records.filter(r => {
            const t = getTimeMs(r.timestamp);
            return isFinite(t) && Math.abs(t - boundaryTime) < 120000; // within 2 min
          });

          const slowRecs = nearRecs.filter(r => {
            const s = typeof r.enhanced_speed === "number" ? r.enhanced_speed :
                      typeof r.speed === "number" ? r.speed : 999;
            return s < 1.5;
          });

          if (slowRecs.length > 20 && nearRecs.length > 0 && slowRecs.length / nearRecs.length > 0.3) {
            // There's a significant slow zone — mark existing legs for user awareness
            // (Don't insert a new leg, but the boundary drag will help)
          }
        }
      }
    }

    // Renumber
    newLegs.forEach((leg, i) => leg.index = i + 1);
    state.legs = newLegs;

    // Rebuild boundaries
    const boundaries = [];
    for (let i = 0; i < newLegs.length - 1; i++) {
      const a = newLegs[i];
      const b = newLegs[i + 1];
      const midMs = (a.end.getTime() + b.start.getTime()) / 2;
      boundaries.push({ index: i, time: new Date(midMs), leftLeg: i, rightLeg: i + 1 });
    }
    state.boundaries = boundaries;
    updateLegsFromBoundaries();
  }

  // ============ BOUNDARIES & CONFIDENCE ============

  function updateLegsFromBoundaries() {
    const legs = state.legs;
    const bounds = state.boundaries;
    if (!legs.length) return;

    for (let i = 0; i < bounds.length; i++) {
      const t = bounds[i].time;
      if (legs[i]) legs[i].end = t;
      if (legs[i + 1]) legs[i + 1].start = t;
    }

    legs.forEach(leg => {
      if (leg.start instanceof Date && leg.end instanceof Date) {
        leg.durationSec = (leg.end.getTime() - leg.start.getTime()) / 1000;
      }
    });

    // Update t0/tEnd
    if (legs.length > 0) {
      state.t0 = legs[0].start;
      state.tEnd = legs[legs.length - 1].end;
    }
  }

  function computeConfidence() {
    const legs = state.legs;
    const allRecords = state.records || [];

    legs.forEach(leg => {
      const recs = getRecordsForLeg(leg, allRecords);
      leg.recordCount = recs.length;

      let score = 0;
      let reasons = [];

      // Sport marker
      if (leg.hasExplicitSport && !leg.isTransition) {
        score += 40; reasons.push("sport marker");
      } else if (leg.hasExplicitSport && leg.isTransition) {
        score += 30; reasons.push("transition marker");
      } else if (leg.detectionSource === "heuristic") {
        score += 15; reasons.push("heuristic");
      } else if (leg.detectionSource === "transition-inferred") {
        score += 10; reasons.push("inferred transition");
      } else {
        reasons.push("no sport marker");
      }

      // Duration
      if (leg.hasExplicitDuration) {
        score += 20; reasons.push("duration present");
      }

      // Records
      if (recs.length > 10) {
        score += 20; reasons.push(recs.length + " records");
      } else if (recs.length > 0) {
        score += 10; reasons.push(recs.length + " records (sparse)");
      } else {
        reasons.push("no records");
      }

      // Sport signals
      const hasPower = recs.some(r => typeof r.power === "number");
      const hasCadence = recs.some(r => typeof r.cadence === "number");
      const hasSpeed = recs.some(r => typeof r.enhanced_speed === "number" || typeof r.speed === "number");
      const hasGPS = recs.some(r => typeof r.position_lat === "number" && typeof r.position_long === "number");

      if (hasPower || hasCadence) { score += 10; reasons.push("power/cadence"); }
      if (hasSpeed) { score += 5; reasons.push("speed"); }
      if (hasGPS) { score += 5; reasons.push("GPS"); }

      // Cap heuristic/inferred legs
      if (leg.detectionSource === "heuristic") score = Math.min(score, 65);
      if (leg.detectionSource === "transition-inferred") score = Math.min(score, 50);

      leg.confidence = Math.min(score, 100);
      leg.confidenceReasons = reasons;

      // #8: Swim metrics
      const effectiveSport = (leg.userSport || leg.sport || "").toLowerCase();
      if (effectiveSport.includes("swim") || effectiveSport === "swimming") {
        leg.swimMetrics = computeSwimMetrics(leg, recs);
      }
    });
  }

  // ============ #2: SPORT RELABELING + LEG TABLE ============

  function getEffectiveSport(leg) {
    return leg.userSport || leg.sport || "unknown";
  }

  const SPORT_OPTIONS = ["swimming", "cycling", "running", "transition", "other"];

  function renderLegTable() {
    legTableBody.innerHTML = "";
    const hasSwim = Object.keys(state.swimFields).length > 0;

    // Show/hide swim columns
    document.querySelectorAll(".swim-col").forEach(el => {
      el.style.display = hasSwim ? "" : "none";
    });

    if (!state.legs.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = hasSwim ? 14 : 12;
      td.textContent = "No legs detected.";
      tr.appendChild(td);
      legTableBody.appendChild(tr);
      return;
    }

    state.legs.forEach((leg, i) => {
      const tr = document.createElement("tr");

      // Checkbox
      const checkCell = document.createElement("td");
      checkCell.className = "leg-radio-cell";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "activeLeg";
      checkbox.className = "leg-radio";
      checkbox.dataset.legIndex = String(i);
      checkbox.addEventListener("change", onActiveLegChange);
      checkCell.appendChild(checkbox);
      tr.appendChild(checkCell);

      addCell(tr, leg.index);
      addCell(tr, leg.sport);

      // #2: Sport override dropdown
      const overrideCell = document.createElement("td");
      const select = document.createElement("select");
      select.className = "sport-select";
      select.dataset.legIndex = String(i);

      const defaultOpt = document.createElement("option");
      defaultOpt.value = "";
      defaultOpt.textContent = "—";
      select.appendChild(defaultOpt);

      SPORT_OPTIONS.forEach(s => {
        const opt = document.createElement("option");
        opt.value = s;
        opt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
        if (leg.userSport === s) opt.selected = true;
        select.appendChild(opt);
      });

      select.addEventListener("change", function () {
        onSportOverride(Number(this.dataset.legIndex), this.value || null);
      });
      overrideCell.appendChild(select);
      tr.appendChild(overrideCell);

      addCell(tr, leg.subsport);
      addCell(tr, leg.isTransition ? "Yes" : "");
      addCell(tr, formatDateTime(leg.start));
      addCell(tr, formatDateTime(leg.end));
      addCell(tr, formatDuration(leg.durationSec));
      addCell(tr, leg.recordCount || 0);

      // Swim columns
      if (hasSwim) {
        const sm = leg.swimMetrics;
        addCell(tr, sm ? sm.totalStrokes : "");
        addCell(tr, sm ? (sm.avgSwolf || "") : "");
      }

      // Confidence
      const confCell = document.createElement("td");
      const conf = leg.confidence || 0;
      confCell.textContent = conf + "%";
      confCell.title = (leg.confidenceReasons || []).join(", ");
      if (conf >= 70) confCell.style.color = "#7af0b8";
      else if (conf >= 40) confCell.style.color = "#ffc857";
      else confCell.style.color = "#ff5b7a";
      tr.appendChild(confCell);

      // Detection source
      addCell(tr, leg.detectionSource || "");

      legTableBody.appendChild(tr);
    });
  }

  function onSportOverride(legIndex, newSport) {
    if (!state.legs[legIndex]) return;
    state.legs[legIndex].userSport = newSport;
    state.legs[legIndex].isTransition = newSport === "transition";

    // Recompute swim metrics if relabeled as swim
    if (newSport && newSport.includes("swim")) {
      const recs = getRecordsForLeg(state.legs[legIndex], state.records);
      state.legs[legIndex].swimMetrics = computeSwimMetrics(state.legs[legIndex], recs);
    }

    renderTimelineBar();
    buildRouteMap();
  }

  function onActiveLegChange(evt) {
    const idx = Number(evt.target.dataset.legIndex);
    if (Number.isNaN(idx) || !state.legs[idx]) return;
    if (evt.target.checked) state.activeLegIndex = idx;
    else if (state.activeLegIndex === idx) state.activeLegIndex = null;

    const selected = getSelectedLegIndices();
    if (selected.length === 1) setExportStatus(`Selected leg #${state.legs[selected[0]].index} for export.`);
    else if (selected.length > 1) setExportStatus(`${selected.length} legs selected for export.`);
    else setExportStatus("");
  }

  function getSelectedLegIndices() {
    const checkboxes = legTableBody.querySelectorAll('input[name="activeLeg"]:checked');
    return Array.from(checkboxes).map(cb => Number(cb.dataset.legIndex)).filter(n => !isNaN(n));
  }

  // ============ #4 / #9: TIMELINE BAR ============

  function renderTimelineBar() {
    if (!timelineBarEl || !state.legs.length) {
      if (timelineBarEl) timelineBarEl.innerHTML = "";
      return;
    }

    const legs = state.legs;
    const totalMs = state.tEnd.getTime() - state.t0.getTime();
    if (totalMs <= 0) return;

    timelineBarEl.innerHTML = "";

    legs.forEach((leg, i) => {
      const legMs = leg.end.getTime() - leg.start.getTime();
      const pct = (legMs / totalMs) * 100;

      const block = document.createElement("div");
      block.className = "timeline-block";
      block.style.width = pct + "%";
      block.style.backgroundColor = LEG_COLORS[i % LEG_COLORS.length];
      block.title = `Leg ${leg.index}: ${getEffectiveSport(leg)} (${formatDuration(leg.durationSec)})`;

      const label = document.createElement("span");
      label.className = "timeline-label";
      const sportName = getEffectiveSport(leg);
      label.textContent = leg.isTransition ? "T" + leg.index :
        (pct > 8 ? sportName.substring(0, 6) : (pct > 4 ? sportName.charAt(0).toUpperCase() : ""));
      block.appendChild(label);

      // Click to focus chart
      block.addEventListener("click", () => focusChartOnLeg(leg));

      timelineBarEl.appendChild(block);

      // Add boundary handle between legs
      if (i < legs.length - 1) {
        const handle = document.createElement("div");
        handle.className = "timeline-boundary";
        handle.dataset.boundaryIndex = String(i);
        timelineBarEl.appendChild(handle);
      }
    });
  }

  function focusChartOnLeg(leg) {
    if (!state.chart || !state.chartT0Ms) return;
    const startMin = (leg.start.getTime() - state.chartT0Ms) / 60000;
    const endMin = (leg.end.getTime() - state.chartT0Ms) / 60000;
    const pad = (endMin - startMin) * 0.1;

    state.chart.options.scales.x.min = startMin - pad;
    state.chart.options.scales.x.max = endMin + pad;
    state.chart.update("none");

    // Double-click to reset zoom
    if (!state.chart._zoomResetAttached) {
      chartCanvas.addEventListener("dblclick", () => {
        delete state.chart.options.scales.x.min;
        delete state.chart.options.scales.x.max;
        state.chart.update("none");
      });
      state.chart._zoomResetAttached = true;
    }
  }

  // #9: Timeline drag
  let timelineDragSetup = false;

  function setupTimelineDrag() {
    if (timelineDragSetup || !timelineBarEl) return;
    timelineDragSetup = true;

    timelineBarEl.addEventListener("mousedown", function (evt) {
      const handle = evt.target.closest(".timeline-boundary");
      if (!handle) return;
      const idx = Number(handle.dataset.boundaryIndex);
      if (isNaN(idx)) return;
      state.timelineDrag.active = true;
      state.timelineDrag.boundaryIndex = idx;
      evt.preventDefault();
    });

    window.addEventListener("mousemove", function (evt) {
      if (!state.timelineDrag.active) return;
      const idx = state.timelineDrag.boundaryIndex;
      const rect = timelineBarEl.getBoundingClientRect();
      const xFrac = (evt.clientX - rect.left) / rect.width;

      const totalMs = state.tEnd.getTime() - state.t0.getTime();
      let newMs = state.t0.getTime() + xFrac * totalMs;

      const legs = state.legs;
      if (!legs[idx] || !legs[idx + 1]) return;

      const minMs = legs[idx].start.getTime() + 1000;
      const maxMs = legs[idx + 1].end.getTime() - 1000;
      if (minMs < maxMs) {
        newMs = Math.max(minMs, Math.min(maxMs, newMs));
      }

      state.boundaries[idx].time = new Date(newMs);
      updateLegsFromBoundaries();
      computeConfidence();
      renderLegTable();
      renderTimelineBar();
      refreshChartBoundaries();
    });

    window.addEventListener("mouseup", function () {
      state.timelineDrag.active = false;
      state.timelineDrag.boundaryIndex = null;
    });
  }

  // ============ CHART ============

  function buildMainChart() {
    if (!chartCanvas || !state.records.length) return;

    const records = state.records.slice().sort((a, b) => getTimeMs(a.timestamp) - getTimeMs(b.timestamp));
    if (!records.length) return;

    const t0 = getTimeMs(records[0].timestamp);
    state.chartT0Ms = t0;

    const points = records.map(r => {
      const ts = getTimeMs(r.timestamp);
      if (!isFinite(ts)) return null;
      const tMin = (ts - t0) / 60000;
      return {
        tMin,
        power: typeof r.power === "number" ? r.power : null,
        hr: typeof r.heart_rate === "number" ? r.heart_rate :
            typeof r.heartRate === "number" ? r.heartRate : null,
        speed: typeof r.enhanced_speed === "number" ? r.enhanced_speed :
               typeof r.speed === "number" ? r.speed : null,
      };
    }).filter(Boolean);

    const maxPoints = 2000;
    const stride = Math.max(1, Math.floor(points.length / maxPoints));
    const ds = points.filter((_, idx) => idx % stride === 0);

    // #13: Downsample indicator
    if (downsampleIndicator && stride > 1) {
      downsampleIndicator.textContent = `(showing 1 in ${stride} points)`;
      downsampleIndicator.style.display = "inline";
    } else if (downsampleIndicator) {
      downsampleIndicator.style.display = "none";
    }

    const powerData = ds.map(p => ({ x: p.tMin, y: p.power }));
    const hrData = ds.map(p => ({ x: p.tMin, y: p.hr }));
    const speedData = ds.map(p => ({ x: p.tMin, y: p.speed != null ? p.speed * 3.6 : null }));

    const boundaryLines = buildBoundaryLines();
    const ctx = chartCanvas.getContext("2d");

    const boundaryPlugin = {
      id: "boundaryLines",
      afterDraw(chart, args, opts) {
        const { ctx, chartArea } = chart;
        const xScale = chart.scales.x;
        if (!xScale) return;

        ctx.save();
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = "rgba(255,255,255,0.65)";
        ctx.font = "10px sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.6)";

        const legs = state.legs;
        (opts.boundaries || []).forEach((b, i) => {
          const x = xScale.getPixelForValue(b.tMin);
          if (x < chartArea.left || x > chartArea.right) return;
          ctx.beginPath();
          ctx.moveTo(x, chartArea.top);
          ctx.lineTo(x, chartArea.bottom);
          ctx.stroke();

          if (legs[i + 1]) {
            const sport = getEffectiveSport(legs[i + 1]);
            const label = legs[i + 1].isTransition ? "T" : sport.substring(0, 4);
            ctx.fillText(label, x + 3, chartArea.top + 12);
          }
        });
        ctx.restore();
      },
    };

    state.chart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [
          { label: "Power (W)", data: powerData, yAxisID: "y", pointRadius: 0, borderWidth: 1, borderColor: "#4ac6ff" },
          { label: "Heart rate (bpm)", data: hrData, yAxisID: "y1", pointRadius: 0, borderWidth: 1, borderColor: "#ff6b9c" },
          { label: "Speed (km/h)", data: speedData, yAxisID: "y2", pointRadius: 0, borderWidth: 1, borderColor: "#ffc857", hidden: true },
        ],
      },
      options: {
        responsive: true,
        animation: false,
        parsing: false,
        plugins: {
          legend: { display: true, labels: { usePointStyle: true, font: { size: 11 } } },
          boundaryLines: { boundaries: boundaryLines },
        },
        scales: {
          x: { type: "linear", title: { display: true, text: "Time (min from file start)" }, ticks: { maxTicksLimit: 10 } },
          y: { position: "left", title: { display: true, text: "Power (W)" } },
          y1: { position: "right", title: { display: true, text: "Heart rate (bpm)" }, grid: { drawOnChartArea: false } },
          y2: { position: "right", title: { display: true, text: "Speed (km/h)" }, grid: { drawOnChartArea: false }, display: false },
        },
      },
      plugins: [boundaryPlugin],
    });

    state.chart.options.plugins.legend.onClick = function (evt, legendItem, legend) {
      const ci = legend.chart;
      const index = legendItem.datasetIndex;
      const meta = ci.getDatasetMeta(index);
      meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
      if (index === 2) ci.options.scales.y2.display = !meta.hidden;
      ci.update();
    };
  }

  function buildBoundaryLines() {
    if (!state.boundaries.length || state.chartT0Ms == null) return [];
    const t0 = state.chartT0Ms;
    return state.boundaries.map(b => ({ tMin: (getTimeMs(b.time) - t0) / 60000 }));
  }

  function refreshChartBoundaries() {
    if (!state.chart) return;
    state.chart.options.plugins.boundaryLines.boundaries = buildBoundaryLines();
    state.chart.update("none");
  }

  // ============ CHART INTERACTIONS (drag) ============

  function setupChartInteractions() {
    if (state.interactionsSetup || !chartCanvas) return;
    state.interactionsSetup = true;

    chartCanvas.addEventListener("mousedown", onChartMouseDown);
    window.addEventListener("mousemove", onChartMouseMove);
    window.addEventListener("mouseup", onChartMouseUp);

    chartCanvas.addEventListener("mousemove", function (evt) {
      if (state.drag.active) return;
      if (!state.chart || !state.boundaries.length) return;
      const xScale = state.chart.scales.x;
      if (!xScale) return;
      const rect = chartCanvas.getBoundingClientRect();
      const xPix = evt.clientX - rect.left;
      const near = state.boundaries.some(b => {
        const tMin = (getTimeMs(b.time) - state.chartT0Ms) / 60000;
        return Math.abs(xScale.getPixelForValue(tMin) - xPix) <= 10;
      });
      chartCanvas.style.cursor = near ? "col-resize" : "";
    });
  }

  function onChartMouseDown(evt) {
    if (!state.chart || !state.boundaries.length) return;
    const xScale = state.chart.scales.x;
    if (!xScale) return;
    const rect = chartCanvas.getBoundingClientRect();
    const xPix = evt.clientX - rect.left;
    let bestIdx = null, bestDist = Infinity;
    state.boundaries.forEach((b, idx) => {
      const px = xScale.getPixelForValue((getTimeMs(b.time) - state.chartT0Ms) / 60000);
      const d = Math.abs(px - xPix);
      if (d < bestDist) { bestDist = d; bestIdx = idx; }
    });
    if (bestIdx != null && bestDist <= 10) {
      state.drag.active = true;
      state.drag.boundaryIndex = bestIdx;
      evt.preventDefault();
    }
  }

  function onChartMouseMove(evt) {
    if (!state.drag.active || state.drag.boundaryIndex == null) return;
    if (!state.chart) return;
    const idx = state.drag.boundaryIndex;
    const xScale = state.chart.scales.x;
    if (!xScale) return;
    const rect = chartCanvas.getBoundingClientRect();
    const xPix = evt.clientX - rect.left;
    let tMin = xScale.getValueForPixel(xPix);
    if (!isFinite(tMin)) return;
    let newMs = state.chartT0Ms + tMin * 60000;
    const legs = state.legs;
    if (!legs[idx] || !legs[idx + 1]) return;
    const minMs = legs[idx].start.getTime() + 1000;
    const maxMs = legs[idx + 1].end.getTime() - 1000;
    if (minMs < maxMs) {
      newMs = Math.max(minMs, Math.min(maxMs, newMs));
    }
    state.boundaries[idx].time = new Date(newMs);
    updateLegsFromBoundaries();
    computeConfidence();
    renderLegTable();
    renderTimelineBar();
    refreshChartBoundaries();
  }

  function onChartMouseUp() {
    state.drag.active = false;
    state.drag.boundaryIndex = null;
  }

  // ============ #13: LAZY MAP ============

  function setupLazyMap() {
    if (!routeMapDiv) return;

    // Use IntersectionObserver for lazy loading
    if ("IntersectionObserver" in window && !state.mapBuilt) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting && !state.mapBuilt) {
            buildRouteMap();
            state.mapBuilt = true;
            observer.disconnect();
          }
        });
      }, { threshold: 0.1 });
      observer.observe(routeMapDiv);
    } else {
      buildRouteMap();
    }
  }

  function buildRouteMap() {
    if (!routeMapDiv) return;

    const allRecs = state.records || [];
    const hasCoords = allRecs.some(
      r => typeof r.position_lat === "number" && typeof r.position_long === "number"
    );

    if (!hasCoords) {
      routeMapDiv.innerHTML = '<div class="route-map-placeholder">No GPS coordinates in this file.</div>';
      return;
    }

    routeMapDiv.innerHTML = "";
    if (state.map) { state.map.remove(); state.map = null; }

    state.map = L.map("routeMap", { zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
    }).addTo(state.map);

    state.mapLayers = [];
    let allCoords = [];

    if (state.legs.length > 0) {
      state.legs.forEach((leg, i) => {
        const recs = getRecordsForLeg(leg, allRecs);
        let coords = recs
          .filter(r => typeof r.position_lat === "number" && typeof r.position_long === "number")
          .map(r => [r.position_lat, r.position_long]);

        // #13: Douglas-Peucker simplification for large tracks
        if (coords.length > 3000) {
          coords = simplifyTrack(coords, 0.00005);
        }

        if (coords.length > 1) {
          const color = LEG_COLORS[i % LEG_COLORS.length];
          const poly = L.polyline(coords, { weight: 3, color, opacity: 0.85 });
          poly.addTo(state.map);
          poly.bindTooltip(`Leg ${leg.index}: ${getEffectiveSport(leg)}`, { sticky: true });
          state.mapLayers.push(poly);
          allCoords = allCoords.concat(coords);
        }
      });
    }

    if (!allCoords.length) {
      let coords = allRecs
        .filter(r => typeof r.position_lat === "number" && typeof r.position_long === "number")
        .map(r => [r.position_lat, r.position_long]);
      if (coords.length > 3000) coords = simplifyTrack(coords, 0.00005);
      if (coords.length > 1) {
        const poly = L.polyline(coords, { weight: 3 });
        poly.addTo(state.map);
        state.mapLayers.push(poly);
        allCoords = coords;
      }
    }

    if (allCoords.length > 0) {
      state.map.fitBounds(L.latLngBounds(allCoords), { padding: [12, 12] });
    }
    state.mapBuilt = true;
  }

  // #13: Simple Douglas-Peucker for track simplification
  function simplifyTrack(points, epsilon) {
    if (points.length <= 2) return points;

    let maxDist = 0, maxIdx = 0;
    const start = points[0], end = points[points.length - 1];

    for (let i = 1; i < points.length - 1; i++) {
      const d = perpDist(points[i], start, end);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }

    if (maxDist > epsilon) {
      const left = simplifyTrack(points.slice(0, maxIdx + 1), epsilon);
      const right = simplifyTrack(points.slice(maxIdx), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [start, end];
  }

  function perpDist(point, lineStart, lineEnd) {
    const dx = lineEnd[0] - lineStart[0];
    const dy = lineEnd[1] - lineStart[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return Math.sqrt(Math.pow(point[0] - lineStart[0], 2) + Math.pow(point[1] - lineStart[1], 2));
    return Math.abs(dx * (lineStart[1] - point[1]) - (lineStart[0] - point[0]) * dy) / len;
  }

  // ============ RECORDS FOR LEG ============

  function getRecordsForLeg(leg, allRecords) {
    if (!allRecords) allRecords = state.records || [];
    if (!allRecords.length) {
      console.warn(`[MSB] getRecordsForLeg: no records in state for leg ${leg.index}`);
      return [];
    }
    const startMs = leg.start instanceof Date ? leg.start.getTime() : new Date(leg.start).getTime();
    const endMs = leg.end instanceof Date ? leg.end.getTime() : new Date(leg.end).getTime();
    if (!isFinite(startMs) || !isFinite(endMs)) {
      console.warn(`[MSB] getRecordsForLeg: invalid start/end for leg ${leg.index}`, leg.start, leg.end);
      return [];
    }
    const result = allRecords.filter(r => {
      const t = getTimeMs(r.timestamp);
      return isFinite(t) && t >= startMs && t <= endMs;
    });
    if (result.length === 0) {
      // Debug: show time range mismatch
      const recTimes = allRecords.slice(0, 3).map(r => getTimeMs(r.timestamp));
      const lastRecTimes = allRecords.slice(-3).map(r => getTimeMs(r.timestamp));
      console.warn(`[MSB] getRecordsForLeg: 0 records for leg ${leg.index}. Leg range: ${startMs}–${endMs}. First record times: ${recTimes}. Last record times: ${lastRecTimes}`);
    }
    return result;
  }

  function getLegRecords(leg) {
    return getRecordsForLeg(leg);
  }

  // ============ TCX SPORT MAPPING ============

  function mapSportToTcx(sport) {
    if (!sport) return "Other";
    const s = sport.toString().toLowerCase();
    if (s.includes("cycling") || s.includes("bike") || s === "biking") return "Biking";
    if (s.includes("run") || s === "running") return "Running";
    return "Other";
  }

  // ============ #11: ENRICHED TCX EXPORT ============

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

  function buildTcxForLeg(leg, recs) {
    const lapStartIso = leg.start.toISOString();
    const effectiveSport = getEffectiveSport(leg);
    const sportAttr = mapSportToTcx(effectiveSport);

    let distOffset = null;
    let trackXml = "";

    recs.forEach(r => {
      // #12: Skip records with invalid timestamps
      const ts = r.timestamp instanceof Date ? r.timestamp.toISOString() :
        (() => { try { return new Date(r.timestamp).toISOString(); } catch { return null; } })();
      if (!ts) return;

      const lat = typeof r.position_lat === "number" ? r.position_lat.toFixed(7) : null;
      const lon = typeof r.position_long === "number" ? r.position_long.toFixed(7) : null;
      const altitude = typeof r.enhanced_altitude === "number" ? r.enhanced_altitude :
                       typeof r.altitude === "number" ? r.altitude : null;

      let dist = typeof r.distance === "number" ? r.distance :
                 typeof r.enhanced_distance === "number" ? r.enhanced_distance : null;
      if (dist != null) {
        if (distOffset === null) distOffset = dist;
        dist = dist - distOffset;
        if (dist < 0) dist = 0;
      }

      const hr = typeof r.heart_rate === "number" ? r.heart_rate :
                 typeof r.heartRate === "number" ? r.heartRate : null;
      const power = typeof r.power === "number" ? r.power :
                    typeof r.watts === "number" ? r.watts : null;
      const speed = typeof r.enhanced_speed === "number" ? r.enhanced_speed :
                    typeof r.speed === "number" ? r.speed : null;
      const cadence = typeof r.cadence === "number" ? r.cadence :
                      typeof r.cad === "number" ? r.cad : null;

      trackXml += "          <Trackpoint>\n";
      trackXml += `            <Time>${ts}</Time>\n`;
      if (lat != null && lon != null) {
        trackXml += "            <Position>\n";
        trackXml += `              <LatitudeDegrees>${lat}</LatitudeDegrees>\n`;
        trackXml += `              <LongitudeDegrees>${lon}</LongitudeDegrees>\n`;
        trackXml += "            </Position>\n";
      }
      if (altitude != null) trackXml += `            <AltitudeMeters>${altitude.toFixed(1)}</AltitudeMeters>\n`;
      if (dist != null) trackXml += `            <DistanceMeters>${dist.toFixed(1)}</DistanceMeters>\n`;
      if (hr != null) {
        trackXml += "            <HeartRateBpm>\n";
        trackXml += `              <Value>${Math.round(hr)}</Value>\n`;
        trackXml += "            </HeartRateBpm>\n";
      }
      if (cadence != null) trackXml += `            <Cadence>${Math.round(cadence)}</Cadence>\n`;
      if (power != null || speed != null) {
        trackXml += "            <Extensions>\n";
        trackXml += "              <ns3:TPX>\n";
        if (power != null) trackXml += `                <ns3:Watts>${Math.round(power)}</ns3:Watts>\n`;
        if (speed != null) trackXml += `                <ns3:Speed>${speed.toFixed(3)}</ns3:Speed>\n`;
        trackXml += "              </ns3:TPX>\n";
        trackXml += "            </Extensions>\n";
      }
      trackXml += "          </Trackpoint>\n";
    });

    // Total distance
    let totalDist = 0;
    if (recs.length > 0) {
      const lastRec = recs[recs.length - 1];
      const lastDist = typeof lastRec.distance === "number" ? lastRec.distance :
                       typeof lastRec.enhanced_distance === "number" ? lastRec.enhanced_distance : null;
      if (lastDist != null && distOffset != null) {
        totalDist = lastDist - distOffset;
        if (totalDist < 0) totalDist = 0;
      }
    }

    const totalTime = leg.durationSec || 0;

    // #11: Lap summary
    const summary = computeLapSummary(recs);

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
      lapExtXml += "        <Extensions>\n          <ns3:LX>\n";
      if (summary.avgPower != null) lapExtXml += `            <ns3:AvgWatts>${summary.avgPower}</ns3:AvgWatts>\n`;
      if (summary.maxPower != null) lapExtXml += `            <ns3:MaxWatts>${summary.maxPower}</ns3:MaxWatts>\n`;
      lapExtXml += "          </ns3:LX>\n        </Extensions>\n";
    }

    // #11: Creator element
    let creatorXml = "";
    if (state.fileId) {
      const name = state.fileId.product_name || state.fileId.garmin_product || state.fileId.manufacturer || "Unknown";
      creatorXml += "      <Creator xsi:type=\"Device_t\">\n";
      creatorXml += `        <Name>${xmlEscape(String(name))}</Name>\n`;
      creatorXml += "      </Creator>\n";
    }

    // #11: Notes
    const notes = `Leg ${leg.index}: ${effectiveSport}. Detection: ${leg.detectionSource || "unknown"}. Confidence: ${leg.confidence || 0}%.`;

    const tcx =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"\n' +
      '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"\n' +
      '  xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"\n' +
      '  xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2\n' +
      '  http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">\n' +
      "  <Activities>\n" +
      `    <Activity Sport="${sportAttr}">\n` +
      `      <Id>${lapStartIso}</Id>\n` +
      `      <Lap StartTime="${lapStartIso}">\n` +
      `        <TotalTimeSeconds>${totalTime.toFixed(1)}</TotalTimeSeconds>\n` +
      `        <DistanceMeters>${totalDist.toFixed(1)}</DistanceMeters>\n` +
      lapSummaryXml +
      "        <Intensity>Active</Intensity>\n" +
      "        <TriggerMethod>Manual</TriggerMethod>\n" +
      lapExtXml +
      "        <Track>\n" +
      trackXml +
      "        </Track>\n" +
      "      </Lap>\n" +
      `      <Notes>${xmlEscape(notes)}</Notes>\n` +
      creatorXml +
      "    </Activity>\n" +
      "  </Activities>\n" +
      "</TrainingCenterDatabase>\n";

    return tcx;
  }

  // ============ JSON EXPORT ============

  function handleDownloadJson(evt) {
    evt.preventDefault();
    if (!state.legs.length) { setStatus("Nothing to export yet."); return; }

    const payload = {
      fileName: state.fileName,
      generatedAt: new Date().toISOString(),
      version: "3.0",
      detectionMethod: state.detectionMethod,
      diagnostics: state.diagnostics,
      legs: state.legs.map(leg => {
        const recs = getLegRecords(leg);
        return {
          index: leg.index,
          sport: leg.sport,
          userSport: leg.userSport,
          effectiveSport: getEffectiveSport(leg),
          subsport: leg.subsport,
          isTransition: leg.isTransition,
          detectionSource: leg.detectionSource,
          start: leg.start.toISOString(),
          end: leg.end.toISOString(),
          durationSec: leg.durationSec,
          confidence: leg.confidence,
          confidenceReasons: leg.confidenceReasons,
          swimMetrics: leg.swimMetrics || null,
          records: recs.map(r => {
            const { timestamp, ...rest } = r;
            const ts = timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
            return { timestamp: ts, ...rest };
          }),
        };
      }),
    };

    downloadBlob(
      JSON.stringify(payload),
      (state.fileName || "multisport").replace(/\.fit$/i, "") + ".legs-debug.json",
      "application/json"
    );
    setStatus("Debug JSON downloaded.");
  }

  // ============ TCX DOWNLOAD ============

  function handleDownloadTcx(evt) {
    evt.preventDefault();
    if (!state.legs.length) { setExportStatus("Nothing to export yet."); return; }
    const selected = getSelectedLegIndices();
    if (selected.length === 0) { setExportStatus("Select at least one leg first."); return; }
    const baseName = (state.fileName || "multisport").replace(/\.fit$/i, "");
    let exported = 0;

    selected.forEach(idx => {
      const leg = state.legs[idx];
      if (!leg) return;
      const recs = getLegRecords(leg);
      if (!recs.length) { setExportStatus(`Leg #${leg.index} has no records — skipped.`); return; }
      const tcx = buildTcxForLeg(leg, recs);
      downloadBlob(tcx, `${baseName}.leg-${leg.index}.tcx`, "application/vnd.garmin.tcx+xml");
      exported++;
    });

    if (exported > 0) setExportStatus(`Downloaded ${exported} TCX file(s).`);
  }

  async function handleDownloadAllTcx(evt) {
    evt.preventDefault();
    if (!state.legs.length) { setExportStatus("Nothing to export yet."); return; }
    const baseName = (state.fileName || "multisport").replace(/\.fit$/i, "");

    // Collect all files
    const files = [];
    const errors = [];
    state.legs.forEach(leg => {
      const recs = getLegRecords(leg);
      if (!recs.length) {
        console.warn(`[MSB] TCX export: leg ${leg.index} has 0 records (start=${leg.start}, end=${leg.end}), skipping.`);
        return;
      }
      try {
        const tcx = buildTcxForLeg(leg, recs);
        files.push({ name: `${baseName}.leg-${leg.index}.tcx`, content: tcx });
      } catch (err) {
        console.error(`[MSB] TCX build error for leg ${leg.index}:`, err);
        errors.push(`Leg ${leg.index}: ${err.message}`);
      }
    });

    if (!files.length) {
      setExportStatus("No legs had records to export." + (errors.length ? " Errors: " + errors.join("; ") : ""));
      return;
    }

    // Single file: download directly
    if (files.length === 1) {
      downloadBlob(files[0].content, files[0].name, "application/vnd.garmin.tcx+xml");
      setExportStatus(`Downloaded 1 leg TCX file.`);
      return;
    }

    // Multiple files: bundle into ZIP
    if (typeof JSZip === "undefined") {
      // Fallback: staggered downloads
      console.warn("[MSB] JSZip not available, using staggered downloads.");
      for (let i = 0; i < files.length; i++) {
        await new Promise(resolve => setTimeout(resolve, i * 500));
        downloadBlob(files[i].content, files[i].name, "application/vnd.garmin.tcx+xml");
      }
      setExportStatus(`Downloaded ${files.length} leg TCX files (staggered).`);
      return;
    }

    setExportStatus(`Zipping ${files.length} TCX files…`);
    const zip = new JSZip();
    files.forEach(f => zip.file(f.name, f.content));
    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, `${baseName}-legs-tcx.zip`, "application/zip");
    setExportStatus(`Downloaded ZIP with ${files.length} leg TCX files.` + (errors.length ? " Errors: " + errors.join("; ") : ""));
  }

  // ============ #6: FIT BINARY EXPORT ============

  const FIT_EPOCH_MS = new Date("1989-12-31T00:00:00Z").getTime();

  function fitTimestamp(date) {
    if (!(date instanceof Date)) date = new Date(date);
    return Math.round((date.getTime() - FIT_EPOCH_MS) / 1000);
  }

  function degreesToSemicircles(deg) {
    return Math.round(deg * (Math.pow(2, 31) / 180));
  }

  function fitCrc16(data) {
    const crcTable = [
      0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
      0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
    ];
    let crc = 0;
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      let tmp = crcTable[crc & 0xF];
      crc = (crc >> 4) & 0x0FFF;
      crc = crc ^ tmp ^ crcTable[byte & 0xF];
      tmp = crcTable[crc & 0xF];
      crc = (crc >> 4) & 0x0FFF;
      crc = crc ^ tmp ^ crcTable[(byte >> 4) & 0xF];
    }
    return crc;
  }

  function buildFitBinary(leg, recs) {
    // FIT file structure:
    // [Header 14 bytes] [Data messages...] [CRC 2 bytes]

    const dataBytes = [];

    function writeU8(v) { dataBytes.push(v & 0xFF); }
    function writeU16LE(v) { dataBytes.push(v & 0xFF); dataBytes.push((v >> 8) & 0xFF); }
    function writeU32LE(v) {
      dataBytes.push(v & 0xFF);
      dataBytes.push((v >> 8) & 0xFF);
      dataBytes.push((v >> 16) & 0xFF);
      dataBytes.push((v >> 24) & 0xFF);
    }
    function writeS32LE(v) {
      const buf = new ArrayBuffer(4);
      new DataView(buf).setInt32(0, v, true);
      const arr = new Uint8Array(buf);
      for (let i = 0; i < 4; i++) dataBytes.push(arr[i]);
    }

    // ---- Definition message for file_id (mesg 0, local 0) ----
    writeU8(0x40); // Definition header: local msg 0
    writeU8(0);    // Reserved
    writeU8(0);    // Architecture: little-endian
    writeU16LE(0); // Global message number: file_id
    writeU8(2);    // Number of fields

    // Field 0: type (enum, 1 byte, field def num 0)
    writeU8(0); writeU8(1); writeU8(0); // field_def_num=0, size=1, base_type=0 (enum)
    // Field 1: manufacturer (uint16, 2 bytes, field def num 1)
    writeU8(1); writeU8(2); writeU8(132); // field_def_num=1, size=2, base_type=132 (uint16)

    // ---- Data message for file_id (local 0) ----
    writeU8(0x00); // Data header: local msg 0
    writeU8(4);    // type = activity
    writeU16LE(255); // manufacturer = development

    // ---- Definition message for record (mesg 20, local 1) ----
    // Fields: timestamp(253), position_lat(0), position_long(1), altitude(2),
    //         heart_rate(3), cadence(4), distance(5), speed(6), power(7), temperature(13)
    writeU8(0x41); // Definition header: local msg 1
    writeU8(0);    // Reserved
    writeU8(0);    // Architecture: little-endian
    writeU16LE(20); // Global message number: record
    writeU8(10);    // Number of fields

    // timestamp: field 253, uint32, base_type 134
    writeU8(253); writeU8(4); writeU8(134);
    // position_lat: field 0, sint32, base_type 133
    writeU8(0); writeU8(4); writeU8(133);
    // position_long: field 1, sint32, base_type 133
    writeU8(1); writeU8(4); writeU8(133);
    // altitude: field 2, uint16, base_type 132 (scale 5, offset 500)
    writeU8(2); writeU8(2); writeU8(132);
    // heart_rate: field 3, uint8, base_type 2
    writeU8(3); writeU8(1); writeU8(2);
    // cadence: field 4, uint8, base_type 2
    writeU8(4); writeU8(1); writeU8(2);
    // distance: field 5, uint32, base_type 134 (scale 100)
    writeU8(5); writeU8(4); writeU8(134);
    // speed: field 6, uint16, base_type 132 (scale 1000)
    writeU8(6); writeU8(2); writeU8(132);
    // power: field 7, uint16, base_type 132
    writeU8(7); writeU8(2); writeU8(132);
    // temperature: field 13, sint8, base_type 1
    writeU8(13); writeU8(1); writeU8(1);

    // ---- Data messages for each record ----
    let distOffset = null;

    recs.forEach(r => {
      const ts = r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp);
      if (isNaN(ts.getTime())) return;

      writeU8(0x01); // Data header: local msg 1

      // timestamp
      writeU32LE(fitTimestamp(ts));

      // position_lat (semicircles, sint32)
      const lat = typeof r.position_lat === "number" ? r.position_lat : null;
      if (lat != null) writeS32LE(degreesToSemicircles(lat));
      else writeU32LE(0x7FFFFFFF); // invalid

      // position_long
      const lon = typeof r.position_long === "number" ? r.position_long : null;
      if (lon != null) writeS32LE(degreesToSemicircles(lon));
      else writeU32LE(0x7FFFFFFF);

      // altitude (uint16, scale 5, offset 500) -> (alt + 500) * 5
      const alt = typeof r.enhanced_altitude === "number" ? r.enhanced_altitude :
                  typeof r.altitude === "number" ? r.altitude : null;
      if (alt != null) writeU16LE(Math.round((alt + 500) * 5));
      else writeU16LE(0xFFFF);

      // heart_rate
      const hr = typeof r.heart_rate === "number" ? r.heart_rate :
                 typeof r.heartRate === "number" ? r.heartRate : null;
      writeU8(hr != null ? Math.round(hr) : 0xFF);

      // cadence
      const cad = typeof r.cadence === "number" ? r.cadence : null;
      writeU8(cad != null ? Math.round(cad) : 0xFF);

      // distance (uint32, scale 100) -> rebased
      let dist = typeof r.distance === "number" ? r.distance :
                 typeof r.enhanced_distance === "number" ? r.enhanced_distance : null;
      if (dist != null) {
        if (distOffset === null) distOffset = dist;
        dist = dist - distOffset;
        if (dist < 0) dist = 0;
        writeU32LE(Math.round(dist * 100));
      } else {
        writeU32LE(0xFFFFFFFF);
      }

      // speed (uint16, scale 1000)
      const spd = typeof r.enhanced_speed === "number" ? r.enhanced_speed :
                  typeof r.speed === "number" ? r.speed : null;
      if (spd != null) writeU16LE(Math.round(spd * 1000));
      else writeU16LE(0xFFFF);

      // power
      const pwr = typeof r.power === "number" ? r.power : null;
      if (pwr != null) writeU16LE(Math.round(pwr));
      else writeU16LE(0xFFFF);

      // temperature (sint8)
      const temp = typeof r.temperature === "number" ? r.temperature : null;
      if (temp != null) {
        const buf = new ArrayBuffer(1);
        new DataView(buf).setInt8(0, Math.round(temp));
        dataBytes.push(new Uint8Array(buf)[0]);
      } else {
        writeU8(0x7F); // invalid sint8
      }
    });

    // Build the complete file
    const dataSize = dataBytes.length;

    // 14-byte header
    const header = new Uint8Array(14);
    const hView = new DataView(header.buffer);
    header[0] = 14;       // header size
    header[1] = 0x20;     // protocol version (2.0)
    hView.setUint16(2, 2160, true); // profile version (21.60)
    hView.setUint32(4, dataSize, true); // data size
    header[8] = 0x2E; // '.'
    header[9] = 0x46; // 'F'
    header[10] = 0x49; // 'I'
    header[11] = 0x54; // 'T'
    // Header CRC (bytes 0-11)
    const headerCrc = fitCrc16(header.slice(0, 12));
    hView.setUint16(12, headerCrc, true);

    // Combine header + data
    const allData = new Uint8Array(14 + dataSize + 2);
    allData.set(header, 0);
    allData.set(new Uint8Array(dataBytes), 14);

    // File CRC (over header + data, NOT including the CRC itself)
    const fileCrc = fitCrc16(allData.slice(0, 14 + dataSize));
    new DataView(allData.buffer).setUint16(14 + dataSize, fileCrc, true);

    return allData.buffer;
  }

  async function handleDownloadAllFit(evt) {
    evt.preventDefault();
    if (!state.legs.length) { setExportStatus("Nothing to export yet."); return; }
    const baseName = (state.fileName || "multisport").replace(/\.fit$/i, "");

    // Collect all files
    const files = [];
    const errors = [];
    state.legs.forEach(leg => {
      const recs = getLegRecords(leg);
      if (!recs.length) {
        console.warn(`[MSB] FIT export: leg ${leg.index} has 0 records (start=${leg.start}, end=${leg.end}), skipping.`);
        return;
      }

      try {
        const fitBuffer = buildFitBinary(leg, recs);
        files.push({ name: `${baseName}.leg-${leg.index}.fit`, content: fitBuffer });
      } catch (err) {
        console.error(`[MSB] FIT build error for leg ${leg.index}:`, err);
        errors.push(`Leg ${leg.index}: ${err.message}`);
      }
    });

    if (!files.length) {
      setExportStatus("No legs had records to export as FIT." + (errors.length ? " Errors: " + errors.join("; ") : ""));
      return;
    }

    // Single file: download directly
    if (files.length === 1) {
      downloadBlob(files[0].content, files[0].name, "application/octet-stream");
      setExportStatus(`Downloaded 1 leg FIT file.`);
      return;
    }

    // Multiple files: bundle into ZIP
    if (typeof JSZip === "undefined") {
      // Fallback: staggered downloads
      console.warn("[MSB] JSZip not available, using staggered downloads.");
      for (let i = 0; i < files.length; i++) {
        await new Promise(resolve => setTimeout(resolve, i * 500));
        downloadBlob(files[i].content, files[i].name, "application/octet-stream");
      }
      setExportStatus(`Downloaded ${files.length} leg FIT files (staggered).`);
      return;
    }

    setExportStatus(`Zipping ${files.length} FIT files…`);
    const zip = new JSZip();
    files.forEach(f => zip.file(f.name, f.content));
    const blob = await zip.generateAsync({ type: "blob" });
    downloadBlob(blob, `${baseName}-legs-fit.zip`, "application/zip");
    setExportStatus(`Downloaded ZIP with ${files.length} leg FIT files.` + (errors.length ? " Errors: " + errors.join("; ") : ""));
  }

  // ============ HELPERS ============

  function downloadBlob(content, fileName, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function addCell(tr, text) {
    const td = document.createElement("td");
    td.textContent = text;
    tr.appendChild(td);
  }

  function xmlEscape(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function normalizeDate(val) {
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    if (val == null) return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d;
  }

  function getTimeMs(val) {
    if (val instanceof Date) return val.getTime();
    if (val == null) return NaN;
    const t = new Date(val);
    return isNaN(t.getTime()) ? NaN : t.getTime();
  }

  function formatDateTime(d) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return "";
    return d.toLocaleString();
  }

  function formatDuration(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return "";
    const total = Math.round(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (x) => String(x).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
})();
