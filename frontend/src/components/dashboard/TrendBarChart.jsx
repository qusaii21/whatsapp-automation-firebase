const CHART_W = 700;
const CHART_H = 200;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 26;

/**
 * @param {Array<{label: string, values: number[]}>} data one entry per x-axis tick
 * @param {Array<{key: string, label: string, color: string}>} series legend/color config, same order as `values`
 */
export default function TrendBarChart({ data, series, emptyLabel = "No activity in this period yet." }) {
  const total = data.reduce((sum, d) => sum + d.values.reduce((a, b) => a + (b || 0), 0), 0);

  if (total === 0) {
    return <div className="chart-empty">{emptyLabel}</div>;
  }

  const max = Math.max(1, ...data.flatMap((d) => d.values.map((v) => v || 0)));
  const plotW = CHART_W - PAD_L - PAD_R;
  const plotH = CHART_H - PAD_T - PAD_B;
  const groupW = plotW / data.length;
  const barGap = 3;
  const barW = Math.max(2, (groupW - barGap * (series.length + 1)) / series.length);

  // Show every label if few groups, else thin them out so text doesn't collide.
  const labelStride = data.length > 10 ? Math.ceil(data.length / 7) : 1;

  return (
    <div className="trend-chart">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="trend-chart-svg" preserveAspectRatio="none">
        {/* baseline */}
        <line x1={PAD_L} y1={CHART_H - PAD_B} x2={CHART_W - PAD_R} y2={CHART_H - PAD_B} stroke="var(--border)" strokeWidth="1" />
        {data.map((d, gi) => {
          const groupX = PAD_L + gi * groupW;
          return (
            <g key={d.label}>
              {series.map((s, si) => {
                const v = d.values[si] || 0;
                const h = (v / max) * plotH;
                const x = groupX + barGap + si * (barW + barGap);
                const y = CHART_H - PAD_B - h;
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={y}
                    width={barW}
                    height={Math.max(h, v > 0 ? 1.5 : 0)}
                    rx={1.5}
                    fill={s.color}
                  >
                    <title>{`${s.label} · ${d.label}: ${v}`}</title>
                  </rect>
                );
              })}
              {gi % labelStride === 0 && (
                <text
                  x={groupX + groupW / 2}
                  y={CHART_H - 8}
                  textAnchor="middle"
                  fontSize="9.5"
                  fill="var(--ink-faint)"
                  fontFamily="var(--font-mono)"
                >
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <div className="trend-chart-legend">
          {series.map((s) => (
            <span key={s.key} className="trend-chart-legend-item">
              <span className="trend-chart-legend-dot" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
