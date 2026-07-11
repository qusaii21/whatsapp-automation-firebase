import { scoreTier } from "../lib/leadScore.js";

const TIER_COLOR = { hot: "#e5484d", warm: "#d78c12", cold: "#3b7bf6" };

export default function ScoreRing({ score, size = 40, strokeWidth = 3.5, showValue = true }) {
  const tier = scoreTier(score);
  const color = TIER_COLOR[tier];
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);

  return (
    <div
      className={`score-ring tier-${tier}`}
      style={{ width: size, height: size }}
      title={`Lead score ${score}/100 (${tier})`}
    >
      <svg width={size} height={size} style={{ position: "absolute", inset: 0, transform: "rotate(-90deg)" }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 0.4s ease" }}
        />
      </svg>
      {showValue && (
        <span className="score-ring-value" style={{ fontSize: size * 0.32 }}>
          {score}
        </span>
      )}
    </div>
  );
}
