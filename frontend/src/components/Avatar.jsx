import { initials, avatarColor } from "../lib/format.js";

export default function Avatar({ name, phone, size = 40 }) {
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, background: avatarColor(name || phone), fontSize: size * 0.36 }}
    >
      {initials(name, phone)}
    </div>
  );
}
