export default function LoadingScreen({ label = "Loading…" }) {
  return (
    <div className="auth-loading-screen">
      <div className="auth-spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}
