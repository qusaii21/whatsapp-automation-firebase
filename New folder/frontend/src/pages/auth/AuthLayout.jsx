export default function AuthLayout({ title, subtitle, children, footer }) {
  return (
    <div className="auth-screen">
      <div className="auth-card card">
        <div className="auth-card-logo">N</div>
        <h1 className="auth-card-title">{title}</h1>
        {subtitle && <p className="auth-card-subtitle">{subtitle}</p>}
        {children}
        {footer && <div className="auth-card-footer">{footer}</div>}
      </div>
    </div>
  );
}
