/** Chart colours and styles. Values are the validated palettes (see docs/brand.md). */
export const C = {
  ink: "#131a18",
  soft: "#4a5752",
  faint: "#7d8a85",
  line: "#e2e7e3",
  surface: "#ffffff",
  panel: "#17332c",
  // delivery outcomes, stacked in this order (worst adjacent CVD ΔE 16.3)
  delivered: "#1d6f45",
  blocked: "#e8896c",
  unreachable: "#5b6fd6",
  failed: "#b07d00",
  // sequential single hue, light → dark (overlap heatmap)
  sequential: ["#eef3f0", "#cfe0d7", "#9fc2b0", "#5f9a80", "#2f6b54", "#17332c"],
};

const font = '"Schibsted Grotesk Variable", ui-sans-serif, system-ui, sans-serif';

/** Shared look: recessive axes and grid, Orbit's type, roomy tooltips. */
export const base = {
  textStyle: { fontFamily: font, color: C.soft },
  animationDuration: 300,
  aria: { enabled: true },
  tooltip: {
    backgroundColor: C.surface,
    borderColor: C.line,
    borderWidth: 1,
    padding: [8, 12],
    textStyle: { color: C.ink, fontFamily: font, fontSize: 12 },
    extraCssText: "border-radius:8px;box-shadow:0 8px 24px -12px rgba(19,26,24,.35);",
  },
  legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 10, itemHeight: 10, textStyle: { color: C.soft, fontSize: 12 } },
  toolbox: {
    right: 0,
    top: -4,
    itemSize: 13,
    iconStyle: { borderColor: C.faint },
    emphasis: { iconStyle: { borderColor: C.ink } },
    feature: { dataZoom: { yAxisIndex: "none", title: { zoom: "Zoom", back: "Reset zoom" } }, saveAsImage: { title: "Save as PNG", pixelRatio: 2 } },
  },
};

export const axis = {
  axisLine: { lineStyle: { color: C.line } },
  axisTick: { show: false },
  axisLabel: { color: C.faint, fontSize: 11 },
  splitLine: { lineStyle: { color: C.line, type: "dashed" as const } },
};

/** Zoom by wheel/drag, plus a slim slider under time charts. */
export const zoom = (show: boolean) =>
  show
    ? [
        { type: "inside" as const, filterMode: "weakFilter" as const },
        {
          type: "slider" as const,
          height: 18,
          bottom: 4,
          borderColor: C.line,
          fillerColor: "rgba(23,51,44,0.08)",
          handleStyle: { color: C.surface, borderColor: C.faint },
          moveHandleSize: 0,
          dataBackground: { lineStyle: { color: C.faint, opacity: 0.4 }, areaStyle: { color: C.line, opacity: 0.6 } },
          textStyle: { color: C.faint, fontSize: 10 },
          showDetail: false,
        },
      ]
    : [];
