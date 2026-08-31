<template>
  <svg
    class="traffic-chart"
    :viewBox="`0 0 ${W} ${H}`"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <defs>
      <linearGradient id="tc-down-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--chart-down)" stop-opacity="0.18" />
        <stop offset="100%" stop-color="var(--chart-down)" stop-opacity="0" />
      </linearGradient>
      <linearGradient id="tc-up-fill" x1="0" y1="0" x2="0" y2="1">
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

    <path :d="areaPath(down)" fill="url(#tc-down-fill)" />
    <path :d="areaPath(up)" fill="url(#tc-up-fill)" />
    <path
      :d="linePath(down)"
      fill="none"
      stroke="var(--chart-down)"
      stroke-width="2"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
    <path
      :d="linePath(up)"
      fill="none"
      stroke="var(--chart-up)"
      stroke-width="2"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ down: number[]; up: number[] }>();

const W = 600;
const H = 148;
const PAD_Y = 6;

const gridYs = [H * 0.25, H * 0.5, H * 0.75];

const maxVal = computed(() => {
  const peak = Math.max(...props.down, ...props.up, 0);
  return peak > 0 ? peak * 1.15 : 1024;
});

function toPoints(series: number[]): Array<[number, number]> {
  const n = series.length;
  if (n === 0) return [];
  const stepX = W / Math.max(n - 1, 1);
  return series.map((v, i) => {
    const x = i * stepX;
    const y = H - PAD_Y - (Math.min(v, maxVal.value) / maxVal.value) * (H - PAD_Y * 2);
    return [x, y];
  });
}

/** Catmull-Rom → cubic Bezier smoothing. */
function smooth(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  const first = points[0];
  if (!first || points.length === 1) return `M ${first?.[0] ?? 0} ${H - PAD_Y}`;
  let d = `M ${first[0].toFixed(1)} ${first[1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i] ?? first;
    const p1 = points[i] ?? first;
    const p2 = points[i + 1] ?? p1;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

const down = computed(() => toPoints(props.down));
const up = computed(() => toPoints(props.up));

function linePath(points: Array<[number, number]>): string {
  return smooth(points);
}

function areaPath(points: Array<[number, number]>): string {
  const line = smooth(points);
  if (!line) return "";
  const last = points[points.length - 1];
  const first = points[0];
  return `${line} L ${last?.[0] ?? W} ${H} L ${first?.[0] ?? 0} ${H} Z`;
}
</script>

<style scoped>
.traffic-chart {
  display: block;
  width: 100%;
  height: 150px;
}
</style>
