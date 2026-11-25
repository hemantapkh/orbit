import { lazy, Suspense } from "react";
import type { ChartProps } from "./EChartImpl";

// ECharts is loaded only when a page actually shows a chart.
const EChartImpl = lazy(() => import("./EChartImpl"));

export function Chart(props: ChartProps) {
  return (
    <Suspense fallback={<div className="animate-pulse rounded-lg bg-line/50" style={{ height: props.height }} />}>
      <EChartImpl {...props} />
    </Suspense>
  );
}
