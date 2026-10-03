// The admin build's AdminPresence (alias list, vite.admin.config.js): nothing.
// Presence (who else is in the admin right now) is dropped (PLAN §2.9); the
// original reads a Firestore listener. The dashboard renders this in its place,
// so the layout closes where the block was.

export default function AdminPresence() {
  return null;
}
