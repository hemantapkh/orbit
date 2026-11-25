import { BarChart, HeatmapChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";

echarts.use([
  BarChart,
  LineChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  ToolboxComponent,
  VisualMapComponent,
  AriaComponent,
  CanvasRenderer,
]);

export type ChartProps = {
  option: echarts.EChartsCoreOption;
  height: number;
  label: string;
  onClick?: (params: { dataIndex: number; seriesName?: string; name?: string }) => void;
};

/** Thin wrapper: one ECharts instance per element, resized with its container. */
export default function EChartImpl({ option, height, label, onClick }: ChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    const node = el.current!;
    const c = echarts.init(node, undefined, { renderer: "canvas" });
    chart.current = c;
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      c.dispose();
      chart.current = null;
    };
  }, []);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge: true });
  }, [option]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !onClick) return;
    c.on("click", onClick as never);
    return () => {
      c.off("click", onClick as never);
    };
  }, [onClick]);

  return <div ref={el} role="img" aria-label={label} style={{ height, width: "100%" }} />;
}
