<template>
  <svg
    class="traffic-chart"
    :style="{ '--traffic-chart-height': `${height}px` }"
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="none"
    role="img"
    :aria-label="label"
  >
    <defs>
      <linearGradient :id="downGradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--chart-down)" stop-opacity="0.18" />
        <stop offset="100%" stop-color="var(--chart-down)" stop-opacity="0" />
      </linearGradient>
      <linearGradient :id="upGradientId" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--chart-up)" stop-opacity="0.14" />
        <stop offset="100%" stop-color="var(--chart-up)" stop-opacity="0" />
      </linearGradient>
    </defs>

    <line
      v-for="y in gridYs"
      :key="y"
      :x1="0"
      :x2="W"
      :y1="y"
      :y2="y"
      stroke="var(--border)"
      stroke-width="1"
      stroke-dasharray="3 5"
    />

    <path :d="downAreaPath" :fill="`url(#${downGradientId})`" />
    <path :d="upAreaPath" :fill="`url(#${upGradientId})`" />
    <path
      :d="downLinePath"
      fill="none"
      stroke="var(--chart-down)"
      stroke-width="2"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
    <path
      :d="upLinePath"
      fill="none"
      stroke="var(--chart-up)"
      stroke-width="2"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed, useId } from "vue";

const props = withDefaults(
  defineProps<{
    down: number[];
    up: number[];
    height?: number;
    label?: string;
  }>(),
  {
    height: 150,
    label: "Live traffic chart",
  },
);

const W = 600;
const H = 148;
const PAD_Y = 6;

const chartId = useId();
const downGradientId = `${chartId}-down-fill`;
const upGradientId = `${chartId}-up-fill`;
const gridYs = [H * 0.25, H * 0.5, H * 0.75];

const maxVal = computed(() => {
  const peak = Math.max(...props.down, ...props.up, 0);
  return peak > 0 ? peak * 1.15 : 1024;
});

function toPoints(series: number[]): Array<[number, number]> {
  const count = series.length;
  if (count === 0) return [];
  const stepX = W / Math.max(count - 1, 1);
  return series.map((value, index) => {
    const x = index * stepX;
    const y = H - PAD_Y - (Math.min(value, maxVal.value) / maxVal.value) * (H - PAD_Y * 2);
    return [x, y];
  });
}

/** Catmull-Rom → cubic Bezier smoothing. */
function smooth(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  const first = points[0];
  if (!first || points.length === 1) return `M ${first?.[0] ?? 0} ${H - PAD_Y}`;
  let path = `M ${first[0].toFixed(1)} ${first[1].toFixed(1)}`;
  for (let index = 0; index < points.length - 1; index++) {
    const p0 = points[index - 1] ?? points[index] ?? first;
    const p1 = points[index] ?? first;
    const p2 = points[index + 1] ?? p1;
    const p3 = points[index + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    path += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return path;
}

function areaPath(points: Array<[number, number]>, line: string): string {
  if (!line) return "";
  const last = points[points.length - 1];
  const first = points[0];
  return `${line} L ${last?.[0] ?? W} ${H} L ${first?.[0] ?? 0} ${H} Z`;
}

const downPoints = computed(() => toPoints(props.down));
const upPoints = computed(() => toPoints(props.up));
const downLinePath = computed(() => smooth(downPoints.value));
const upLinePath = computed(() => smooth(upPoints.value));
const downAreaPath = computed(() => areaPath(downPoints.value, downLinePath.value));
const upAreaPath = computed(() => areaPath(upPoints.value, upLinePath.value));
</script>

<style scoped>
.traffic-chart {
  display: block;
  width: 100%;
  height: var(--traffic-chart-height);
  min-height: 0;
}
</style>
