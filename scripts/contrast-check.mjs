function lum(hex) {
  const c = hex.replace("#", "");
  const f = (i) => {
    const v = parseInt(c.substr(i, 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(0) + 0.7152 * f(2) + 0.0722 * f(4);
}
function cr(a, b) {
  const l1 = lum(a);
  const l2 = lum(b);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}
const cases = [
  ["accent vs white", "#1e7693", "#ffffff", 4.5],
  ["accent-hover vs white", "#1a6885", "#ffffff", 4.5],
  ["accent-pressed vs white", "#15566e", "#ffffff", 4.5],
  ["accent text on accent-soft", "#1e7693", "#e8f5fa", 4.5],
  ["accent text on panel", "#1e7693", "#f1f1f1", 4.5],
  ["selection vs white", "#1c7a4a", "#ffffff", 4.5],
  ["selection vs selection-soft", "#1c7a4a", "#e8f7ef", 4.5],
  ["selection vs panel", "#1c7a4a", "#f1f1f1", 4.5],
  ["success vs white", "#157f4c", "#ffffff", 4.5],
  ["success vs success-soft", "#157f4c", "#e8f7ef", 4.5],
  ["muted vs white", "#5f6a76", "#ffffff", 4.5],
  ["muted vs panel", "#5f6a76", "#f1f1f1", 4.5],
  ["muted vs hover", "#5f6a76", "#eaeaea", 4.5],
  ["muted vs inset", "#5f6a76", "#eeeeee", 4.5],
  ["info vs info-soft", "#1f6a8f", "#eaf4f9", 4.5],
  ["danger vs white", "#c13a3a", "#ffffff", 4.5],
  ["danger vs panel", "#c13a3a", "#f1f1f1", 4.5],
  ["danger vs danger-soft", "#c13a3a", "#fceded", 4.5],
  ["danger-hover vs white text", "#a83030", "#ffffff", 4.5],
  ["chart-down vs white", "#1e7693", "#ffffff", 4.5],
  ["chart-up vs white", "#6558b8", "#ffffff", 4.5],
  ["warning vs white", "#9a650d", "#ffffff", 4.5],
  ["warning vs warning-soft", "#9a650d", "#fff6dc", 4.5],
  ["switch-off vs white (3:1)", "#8a8690", "#ffffff", 3.0],
  ["switch-off vs panel (3:1)", "#8a8690", "#f1f1f1", 3.0],
  ["dark accent vs inverse text", "#3aa1cc", "#191722", 4.5],
  ["dark accent-hover vs inverse", "#52b7de", "#191722", 4.5],
  ["dark accent-pressed vs inverse", "#2d8db5", "#191722", 4.5],
  ["dark chart-up vs elevated", "#b0a7f2", "#403e4b", 4.5],
  ["dark chart-down vs elevated", "#50b8df", "#403e4b", 4.5],
];
let fail = 0;
for (const [name, fg, bg, req] of cases) {
  const v = cr(fg, bg);
  const ok = v >= req;
  if (!ok) fail++;
  console.log(
    (ok ? "PASS" : "FAIL").padEnd(5),
    name.padEnd(32),
    `${v.toFixed(2)}:1`,
    `(need ${req})`,
  );
}
console.log(fail === 0 ? "ALL PASS" : `${fail} FAILURES`);
