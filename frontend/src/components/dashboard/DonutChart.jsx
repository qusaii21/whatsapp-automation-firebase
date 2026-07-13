const SIZE = 140;
const STROKE = 20;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * @param {Array<{label: string, value: number, color: string}>} data
 */
export default function DonutChart({ data, emptyLabel = "No data yet." }) {
  const segments = data.filter((d) => d.value > 0);
  const total = segments.reduce((sum, d) => sum + d.value, 0);

  if (total === 0) {
    return <div className="chart-empty">{emptyLabel}</div>;
  }

  let offsetSoFar = 0;

  return (
    <div className="donut-chart">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="donut-chart-svg">
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--surface-2)" strokeWidth={STROKE} />
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {segments.map((seg) => {
            const fraction = seg.value / total;
            const dash = fraction * CIRCUMFERENCE;
            const gap = CIRCUMFERENCE - dash;
            const el = (
              <circle
                key={seg.label}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={RADIUS}
                fill="none"
                stroke={seg.color}
                strokeWidth={STROKE}
                strokeDasharray={`${dash} ${gap}`}
                strokeDashoffset={-offsetSoFar}
              >
                <title>{`${seg.label}: ${seg.value}`}</title>
              </circle>
            );
            offsetSoFar += dash;
            return el;
          })}
        </g>
        <text x={SIZE / 2} y={SIZE / 2 - 3} textAnchor="middle" fontSize="20" fontWeight="700" fill="var(--ink)" fontFamily="var(--font-mono)">
          {total}
        </text>
        <text x={SIZE / 2} y={SIZE / 2 + 13} textAnchor="middle" fontSize="9.5" fill="var(--ink-muted)">
          total
        </text>
      </svg>
      <div className="donut-chart-legend">
        {segments.map((seg) => (
          <span key={seg.label} className="donut-chart-legend-item">
            <span className="donut-chart-legend-dot" style={{ background: seg.color }} />
            {seg.label}
            <span className="donut-chart-legend-value">{seg.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
