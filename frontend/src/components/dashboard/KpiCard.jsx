export default function KpiCard({ icon: Icon, label, value, sub, loading, tone = "default" }) {
  return (
    <div className={`kpi-card kpi-card-${tone}`}>
      <div className="kpi-card-top">
        <span className="kpi-card-label">{label}</span>
        {Icon && (
          <span className="kpi-card-icon">
            <Icon size={16} />
          </span>
        )}
      </div>
      {loading ? (
        <div className="skeleton skeleton-line" style={{ width: "60%", height: 24, marginTop: 6 }} />
      ) : (
        <div className="kpi-card-value">{value}</div>
      )}
      {sub && !loading && <div className="kpi-card-sub">{sub}</div>}
    </div>
  );
}
