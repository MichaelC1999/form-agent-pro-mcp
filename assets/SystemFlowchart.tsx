/**
 * SystemFlowchart.tsx
 *
 * Immigration Form Filling — Production Data Flow
 *
 * Renders a self-contained SVG diagram showing the end-to-end data flow:
 *
 *   TRACK A (admin, once per form)
 *     Blank PDF  ──►  buildFormMap  ──►  FormMap (MongoDB)
 *                ──►  buildFormContext  ──►  FormContext (MongoDB)
 *
 *   TRACK B (user, once per session)
 *     User Documents + UI Answers  ──►  buildSituationContext  ──►  SituationalContext (MongoDB)
 *
 *   CONVERGENCE (once per user × form)
 *     FormContext + SituationalContext + assumptionLevel  ──►  fillFormMap  ──►  FilledFormMap (MongoDB)
 *
 *   OUTPUT (once per user × form)
 *     FilledFormMap + Blank PDF  ──►  fillForm  ──►  Filled PDF (disk)
 *
 * Usage:
 *   import { SystemFlowchart } from "./SystemFlowchart";
 *   <SystemFlowchart />
 */

import React from "react";

// ─── Design tokens ────────────────────────────────────────────────────────────

const C = {
  bg:           "#0d1117",
  trackBg:      "#161b22",
  trackBorder:  "#30363d",

  inputData: { fill: "#0d3349", stroke: "#4fc3f7", text: "#4fc3f7" },
  anthropic:  { fill: "#2a1a3a", stroke: "#ce93d8", text: "#ce93d8" },
  service:    { fill: "#0d2a28", stroke: "#80cbc4", text: "#80cbc4" },
  mongo:      { fill: "#3a2200", stroke: "#ffb74d", text: "#ffb74d" },
  output:     { fill: "#1a2e1a", stroke: "#a5d6a7", text: "#a5d6a7" },
  param:      { fill: "#1c2333", stroke: "#90a4ae", text: "#90a4ae" },

  arrow:      "#58a6ff",
  arrowMuted: "#484f58",
  label:      "#8b949e",
  trackLabel: "#484f58",
  white:      "#e6edf3",
} as const;

type NodeStyle = { fill: string; stroke: string; text: string };

const FONT = "'SF Mono','Fira Code','Cascadia Code',monospace";

// ─── Primitives ───────────────────────────────────────────────────────────────

/** Rounded-rect node with optional subtitle. */
function Box({
  x, y, w, h,
  label, sub,
  style, rx = 6,
}: {
  x: number; y: number; w: number; h: number;
  label: string; sub?: string;
  style: NodeStyle; rx?: number;
}) {
  const cy = sub ? y + h / 2 - 7 : y + h / 2 + 1;
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={rx}
        fill={style.fill} stroke={style.stroke} strokeWidth={1.5} />
      <text x={x + w / 2} y={cy}
        textAnchor="middle" dominantBaseline="middle"
        fill={style.text} fontSize={11} fontWeight="600" fontFamily={FONT}>
        {label}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + h / 2 + 9}
          textAnchor="middle" dominantBaseline="middle"
          fill={C.label} fontSize={8.5} fontFamily={FONT}>
          {sub}
        </text>
      )}
    </g>
  );
}

/** Straight arrow between two absolute points. */
function Arrow({
  x1, y1, x2, y2,
  color = C.arrow,
  dashed = false,
  marker = "arrow-blue",
}: {
  x1: number; y1: number; x2: number; y2: number;
  color?: string; dashed?: boolean; marker?: string;
}) {
  return (
    <line x1={x1} y1={y1} x2={x2} y2={y2}
      stroke={color} strokeWidth={1.5}
      strokeDasharray={dashed ? "5 3" : undefined}
      markerEnd={`url(#${marker})`} />
  );
}

/** Two-segment elbow: vertical then horizontal (or vice-versa). */
function Elbow({
  x1, y1, x2, y2,
  color = C.arrow,
  dashed = false,
  marker = "arrow-blue",
  bend = "v-then-h",  // "v-then-h" | "h-then-v"
}: {
  x1: number; y1: number; x2: number; y2: number;
  color?: string; dashed?: boolean; marker?: string;
  bend?: "v-then-h" | "h-then-v";
}) {
  let d: string;
  if (bend === "v-then-h") {
    // go down, then across
    d = `M${x1},${y1} L${x1},${y2} L${x2},${y2}`;
  } else {
    // go across, then down
    d = `M${x1},${y1} L${x2},${y1} L${x2},${y2}`;
  }
  return (
    <path d={d} fill="none"
      stroke={color} strokeWidth={1.5}
      strokeDasharray={dashed ? "5 3" : undefined}
      markerEnd={`url(#${marker})`} />
  );
}

/** Dashed section track band. */
function Track({
  x, y, w, h, label,
}: { x: number; y: number; w: number; h: number; label: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8}
        fill={C.trackBg} stroke={C.trackBorder}
        strokeWidth={1} strokeDasharray="6 3" />
      <text x={x + 12} y={y + 15}
        fill={C.trackLabel} fontSize={8.5} fontWeight="700"
        fontFamily={FONT} letterSpacing="1.2">
        {label.toUpperCase()}
      </text>
    </g>
  );
}

/** Legend row. */
function Legend({ x, y }: { x: number; y: number }) {
  const items: Array<{ label: string; style: NodeStyle }> = [
    { label: "Input Data",        style: C.inputData },
    { label: "Anthropic API",     style: C.anthropic  },
    { label: "Service / Process", style: C.service    },
    { label: "MongoDB Object",    style: C.mongo      },
    { label: "Output Artifact",   style: C.output     },
    { label: "Parameter",         style: C.param      },
  ];
  return (
    <g>
      {items.map((it, i) => (
        <g key={it.label} transform={`translate(${x + i * 150}, ${y})`}>
          <rect width={10} height={10} rx={2}
            fill={it.style.fill} stroke={it.style.stroke} strokeWidth={1.5} />
          <text x={14} y={9} fill={C.label} fontSize={9.5} fontFamily={FONT}>
            {it.label}
          </text>
        </g>
      ))}
    </g>
  );
}

// ─── Diagram layout constants ─────────────────────────────────────────────────
//
//  x-axis (column centers):
//    ADMIN track:  col A = 170
//    USER track:   col B = 520,  col B2 = 710  (UI Answers node)
//    MERGE col:    col M = 420
//
//  y-axis (node tops):
//    title / legend:   20 / 55
//    track A/B top:    90
//    row 1 (inputs):   110
//    row 2 (services): 195
//    row 3 (mongo):    280
//    -- Track A only --
//    row 4 (service2): 365  (buildFormContext)
//    row 5 (mongo2):   450  (FormContext)
//    -- convergence --
//    conv track top:   520
//    row 6 (service):  540
//    row 7 (mongo):    625
//    -- output --
//    out track top:    685
//    row 8 (service):  705
//    row 9 (output):   790

const NW  = 190;  // standard node width
const NW2 = 150;  // narrow node width
const NH  = 46;   // node height

const cA  = 170;  // admin column center
const cB  = 500;  // user column center
const cB2 = 710;  // UI-Answers column center
const cM  = 420;  // merge column center (fillFormMap)

const yR1 = 115;  // row 1 (inputs)
const yR2 = 200;  // row 2 (first services)
const yR3 = 285;  // row 3 (first mongo outputs)
const yR4 = 370;  // row 4 (buildFormContext)
const yR5 = 455;  // row 5 (FormContext)
const yR6 = 555;  // row 6 (fillFormMap)
const yR7 = 640;  // row 7 (FilledFormMap)
const yR8 = 730;  // row 8 (fillForm)
const yR9 = 815;  // row 9 (Filled PDF)

// Track bounding boxes
const tA = { x: 18,  y: 92,  w: 320, h: 428 }; // admin
const tB = { x: 358, y: 92,  w: 400, h: 260 }; // user
const tC = { x: 18,  y: 530, w: 840, h: 138 }; // convergence
const tO = { x: 18,  y: 700, w: 840, h: 154 }; // output

const W = 900;
const H = 1000;

// ─── Component ────────────────────────────────────────────────────────────────

export function SystemFlowchart() {
  return (
    <svg
      width={W} height={H}
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ background: C.bg, display: "block" }}
    >
      {/* ── Marker defs ── */}
      <defs>
        <marker id="arrow-blue" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill={C.arrow} />
        </marker>
        <marker id="arrow-muted" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
          <path d="M0,0 L0,6 L8,3 z" fill={C.arrowMuted} />
        </marker>
      </defs>

      {/* ── Title ── */}
      <text x={W / 2} y={30} textAnchor="middle"
        fill={C.white} fontSize={15} fontWeight="700" fontFamily={FONT} letterSpacing=".4">
        Immigration Form Filling — Production Data Flow
      </text>

      {/* ── Legend ── */}
      <Legend x={15} y={55} />

      {/* ════════════════════════════
          TRACK A — FORM SETUP (admin)
          ════════════════════════════ */}
      <Track {...tA} label="Form Setup · Admin — Once Per Form" />

      {/* Blank PDF (admin input) */}
      <Box x={cA - NW/2} y={yR1} w={NW} h={NH}
        label="Blank PDF Template" sub="disk · /forms/<formId>.pdf"
        style={C.inputData} />

      {/* Blank PDF → buildFormMap */}
      <Arrow x1={cA} y1={yR1+NH} x2={cA} y2={yR2-6} />

      {/* buildFormMap service */}
      <Box x={cA - NW/2} y={yR2} w={NW} h={NH}
        label="buildFormMap" sub="pdftk → pdf-lib → qpdf → raw-scan"
        style={C.service} />

      {/* buildFormMap → FormMap */}
      <Arrow x1={cA} y1={yR2+NH} x2={cA} y2={yR3-6} />

      {/* FormMap (MongoDB) */}
      <Box x={cA - NW/2} y={yR3} w={NW} h={NH}
        label="[form]-map" sub="MongoDB · empty field IDs"
        style={C.mongo} />

      {/* FormMap → buildFormContext (vertical) */}
      <Arrow x1={cA} y1={yR3+NH} x2={cA} y2={yR4-6} />

      {/*
        Blank PDF also feeds buildFormContext.
        Route: right edge of Blank PDF → elbow right → down → left into buildFormContext.
      */}
      <Elbow
        x1={cA + NW/2} y1={yR1 + NH/2}
        x2={cA + NW/2 + 40} y2={yR4 + NH/2}
        bend="v-then-h"
        color={C.arrowMuted} dashed marker="arrow-muted"
      />
      <Arrow
        x1={cA + NW/2 + 40} y1={yR4 + NH/2}
        x2={cA + NW/2 + 6}  y2={yR4 + NH/2}
        color={C.arrowMuted} marker="arrow-muted"
      />

      {/* buildFormContext (Anthropic call) */}
      <Box x={cA - NW/2} y={yR4} w={NW} h={NH}
        label="buildFormContext" sub="Anthropic fn · claude-opus-4-5"
        style={C.anthropic} />

      {/* buildFormContext → FormContext */}
      <Arrow x1={cA} y1={yR4+NH} x2={cA} y2={yR5-6} />

      {/* FormContext (MongoDB) */}
      <Box x={cA - NW/2} y={yR5} w={NW} h={NH}
        label="[form]-context" sub="MongoDB · annotated field descriptions"
        style={C.mongo} />

      {/* ═════════════════════════════════
          TRACK B — USER DATA COLLECTION
          ═════════════════════════════════ */}
      <Track {...tB} label="User Data Collection · Once Per User Session" />

      {/* User Documents */}
      <Box x={cB - NW/2} y={yR1} w={NW} h={NH}
        label="User Documents" sub="multipart · passports, visas, I-94, etc."
        style={C.inputData} />

      {/* UI Answers */}
      <Box x={cB2 - NW2/2} y={yR1} w={NW2} h={NH}
        label="UI Answers" sub="situationDescription, processDescription"
        style={C.param} />

      {/* User Docs → buildSituationContext */}
      <Arrow x1={cB} y1={yR1+NH} x2={cB} y2={yR2-6} />

      {/* UI Answers → buildSituationContext (elbow right-to-left) */}
      <Elbow
        x1={cB2} y1={yR1 + NH}
        x2={cB + NW/2} y2={yR2 + NH/2}
        bend="v-then-h"
        color={C.arrow}
      />
      <Arrow
        x1={cB + NW/2} y1={yR2 + NH/2}
        x2={cB + NW/2 - 6} y2={yR2 + NH/2}
        color={C.arrow}
      />

      {/* buildSituationContext (Anthropic call) */}
      <Box x={cB - NW/2} y={yR2} w={NW} h={NH}
        label="buildSituationContext" sub="OCR / pdf-parse + Anthropic fn"
        style={C.anthropic} />

      {/* buildSituationContext → SituationalContext */}
      <Arrow x1={cB} y1={yR2+NH} x2={cB} y2={yR3-6} />

      {/* SituationalContext (MongoDB) */}
      <Box x={cB - NW/2} y={yR3} w={NW} h={NH}
        label="[user][date]-situational" sub="MongoDB · partyData + situationSummary"
        style={C.mongo} />

      {/* ══════════════════════════════════════
          CONVERGENCE — fillFormMap
          ══════════════════════════════════════ */}
      <Track {...tC} label="Fill Form Map · Once Per User × Form" />

      {/* assumptionLevel param */}
      <Box x={30} y={yR6} w={NW2} h={NH}
        label="assumptionLevel" sub="conservative | moderate | liberal"
        style={C.param} />

      {/* fillFormMap (Anthropic call) */}
      <Box x={cM - NW/2} y={yR6} w={NW} h={NH}
        label="fillFormMap" sub="Anthropic fn · claude-opus-4-5"
        style={C.anthropic} />

      {/* FormContext → fillFormMap (elbow down-right) */}
      <Elbow
        x1={cA} y1={yR5 + NH}
        x2={cM - NW/2} y2={yR6 + NH/2}
        bend="v-then-h"
        color={C.arrow}
      />
      <Arrow
        x1={cM - NW/2} y1={yR6 + NH/2}
        x2={cM - NW/2 + 6} y2={yR6 + NH/2}
        color={C.arrow}
      />

      {/* SituationalContext → fillFormMap (elbow down-left) */}
      <Elbow
        x1={cB} y1={yR3 + NH}
        x2={cM + NW/2} y2={yR6 + NH/2}
        bend="v-then-h"
        color={C.arrow}
      />
      <Arrow
        x1={cM + NW/2} y1={yR6 + NH/2}
        x2={cM + NW/2 - 6} y2={yR6 + NH/2}
        color={C.arrow}
      />

      {/* assumptionLevel → fillFormMap */}
      <Arrow x1={30 + NW2} y1={yR6 + NH/2} x2={cM - NW/2 - 6} y2={yR6 + NH/2} />

      {/* fillFormMap → FilledFormMap */}
      <Arrow x1={cM} y1={yR6+NH} x2={cM} y2={yR7-6} />

      {/* FilledFormMap (MongoDB) */}
      <Box x={cM - NW/2} y={yR7} w={NW} h={NH}
        label="[form]-map-[user]-[date]" sub="MongoDB · filled values + skipped audit"
        style={C.mongo} />

      {/* ══════════════════════════════
          OUTPUT — fillForm
          ══════════════════════════════ */}
      <Track {...tO} label="Fill Form · Produce Output PDF" />

      {/* Blank PDF (reused) */}
      <Box x={30} y={yR8} w={NW2} h={NH}
        label="Blank PDF Template" sub="disk · /forms/<formId>.pdf"
        style={C.inputData} />

      {/* fillForm service */}
      <Box x={cM - NW/2} y={yR8} w={NW} h={NH}
        label="fillForm" sub="pdftk fill_form + flatten"
        style={C.service} />

      {/* FilledFormMap → fillForm */}
      <Arrow x1={cM} y1={yR7+NH} x2={cM} y2={yR8-6} />

      {/* Blank PDF → fillForm */}
      <Arrow x1={30 + NW2} y1={yR8 + NH/2} x2={cM - NW/2 - 6} y2={yR8 + NH/2} />

      {/* fillForm → Filled PDF */}
      <Arrow x1={cM} y1={yR8+NH} x2={cM} y2={yR9-6} />

      {/* Filled PDF (output) */}
      <Box x={cM - NW/2} y={yR9} w={NW} h={NH}
        label="Filled PDF" sub="disk · output/<formId>/<userId>-<ts>.pdf"
        style={C.output} />

      {/* ── Annotation labels ── */}

      {/* "reads FormMap" label on arrow from FormMap → buildFormContext */}
      <text x={cA + NW/2 + 44} y={yR4 + NH/2 - 4}
        fill={C.label} fontSize={8} fontFamily={FONT}>reads FormMap</text>

      {/* "reads FormContext" label */}
      <text x={cA + 2} y={(yR5 + NH + yR6) / 2 + 3}
        fill={C.label} fontSize={8} fontFamily={FONT}>reads FormContext</text>

      {/* "reads SituationalContext" label */}
      <text x={cB + 2} y={(yR3 + NH + yR6) / 2 + 3}
        fill={C.label} fontSize={8} fontFamily={FONT}>reads SituationalContext</text>

      {/* "reads FilledFormMap" label */}
      <text x={cM + 4} y={(yR7 + NH + yR8) / 2 + 3}
        fill={C.label} fontSize={8} fontFamily={FONT}>reads FilledFormMap</text>

      {/* ── API endpoint labels ── */}
      <text x={20} y={89} fill={C.label} fontSize={8} fontFamily={FONT}>
        POST /api/form-map/build  ·  POST /api/form-context/build
      </text>
      <text x={360} y={89} fill={C.label} fontSize={8} fontFamily={FONT}>
        POST /api/situation/build
      </text>
      <text x={20} y={527} fill={C.label} fontSize={8} fontFamily={FONT}>
        POST /api/filled-form-map/build
      </text>
      <text x={20} y={697} fill={C.label} fontSize={8} fontFamily={FONT}>
        POST /api/form-fill/fill
      </text>

      {/* ── MongoDB collections footer ── */}
      <rect x={18} y={876} width={862} height={64} rx={6}
        fill={C.trackBg} stroke={C.trackBorder} strokeWidth={1} />
      <text x={30} y={892} fill={C.trackLabel} fontSize={8.5} fontWeight="700"
        fontFamily={FONT} letterSpacing="1.2">
        MONGODB COLLECTIONS
      </text>
      {([
        { model: "FormMap",            coll: "form_maps",            note: "blank field IDs, once per form" },
        { model: "FormContext",         coll: "form_contexts",        note: "annotated field descriptions" },
        { model: "SituationalContext",  coll: "situational_contexts", note: "partyData per user session" },
        { model: "FilledFormMap",       coll: "filled_form_maps",     note: "filled values per user × form" },
      ] as const).map((m, i) => (
        <g key={m.model} transform={`translate(${30 + i * 215}, 898)`}>
          <rect width={208} height={30} rx={4}
            fill={C.mongo.fill} stroke={C.mongo.stroke} strokeWidth={1} />
          <text x={8} y={12} fill={C.mongo.text} fontSize={10} fontWeight="600" fontFamily={FONT}>
            {m.model}
          </text>
          <text x={8} y={24} fill={C.label} fontSize={8} fontFamily={FONT}>
            {m.note}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default SystemFlowchart;
