// SVG path for a small sparkline. Null points break the line instead of dropping to zero.
export function sparkPath(values: (number | null)[], width: number, height: number, pad = 2): string {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length < 2) return "";
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  let out = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      pen = false;
      return;
    }
    const x = (i * step).toFixed(1);
    const y = (height - pad - ((v - min) / span) * (height - pad * 2)).toFixed(1);
    out += `${pen ? "L" : "M"}${x} ${y} `;
    pen = true;
  });
  return out.trim();
}
