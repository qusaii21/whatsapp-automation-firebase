export default function SectionCard({ title, subtitle, action, children, className = "" }) {
  return (
    <div className={`card section-card ${className}`}>
      <div className="section-card-header">
        <div>
          <div className="section-card-title">{title}</div>
          {subtitle && <div className="section-card-subtitle">{subtitle}</div>}
        </div>
        {action && <div className="section-card-action">{action}</div>}
      </div>
      <div className="section-card-body">{children}</div>
    </div>
  );
}
