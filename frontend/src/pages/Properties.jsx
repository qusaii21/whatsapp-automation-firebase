import { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  updateDoc,
} from "firebase/firestore";
import {
  getDownloadURL,
  ref,
  uploadBytes,
  deleteObject,
} from "firebase/storage";
import { db, storage } from "../firebase.js";

const EMPTY_FORM = {
  title: "",
  bedrooms: "",
  budget: "",
  location: "",
  description: "",
  photoFile: null,
};

export default function Properties() {
  const [properties, setProperties] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);
  const [existingImageUrl, setExistingImageUrl] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "properties"), (snapshot) => {
      setProperties(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
    return unsubscribe;
  }, []);

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setExistingImageUrl(null);
  }

  function startEdit(property) {
    setEditingId(property.id);
    setExistingImageUrl(property.imageUrl || null);
    setForm({
      title: property.title || "",
      bedrooms: property.bedrooms ?? "",
      budget: property.budget ?? "",
      location: property.location || "",
      description: property.description || "",
      photoFile: null,
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      let imageUrl = existingImageUrl || "";

      if (form.photoFile) {
        const storageRef = ref(
          storage,
          `property-photos/${Date.now()}-${form.photoFile.name}`
        );
        await uploadBytes(storageRef, form.photoFile);
        imageUrl = await getDownloadURL(storageRef);
      }

      const payload = {
        title: form.title.trim(),
        bedrooms: Number(form.bedrooms) || 0,
        budget: Number(form.budget) || 0,
        location: form.location.trim(),
        description: form.description.trim(),
        imageUrl,
      };

      if (editingId) {
        await updateDoc(doc(db, "properties", editingId), payload);
      } else {
        await addDoc(collection(db, "properties"), payload);
      }

      resetForm();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(property) {
    if (!confirm(`Delete "${property.title}"?`)) return;

    if (property.imageUrl) {
      try {
        // Best-effort cleanup; ignore if the object is already gone or the
        // URL wasn't one we control.
        const storageRef = ref(storage, property.imageUrl);
        await deleteObject(storageRef);
      } catch {
        // no-op
      }
    }

    await deleteDoc(doc(db, "properties", property.id));
    if (editingId === property.id) resetForm();
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Properties</h1>
      </div>

      <form className="property-form" onSubmit={handleSubmit}>
        <h2>{editingId ? "Edit property" : "Add property"}</h2>

        <div className="form-grid">
          <label>
            Title
            <input
              type="text"
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>

          <label>
            Bedrooms
            <input
              type="number"
              min="0"
              required
              value={form.bedrooms}
              onChange={(e) => setForm({ ...form, bedrooms: e.target.value })}
            />
          </label>

          <label>
            Budget
            <input
              type="number"
              min="0"
              required
              value={form.budget}
              onChange={(e) => setForm({ ...form, budget: e.target.value })}
            />
          </label>

          <label>
            Location
            <input
              type="text"
              required
              value={form.location}
              onChange={(e) => setForm({ ...form, location: e.target.value })}
            />
          </label>

          <label className="form-full-width">
            Description
            <textarea
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </label>

          <label className="form-full-width">
            Photo {existingImageUrl && !form.photoFile && "(leave blank to keep current photo)"}
            <input
              type="file"
              accept="image/*"
              onChange={(e) => setForm({ ...form, photoFile: e.target.files[0] })}
            />
          </label>
        </div>

        <div className="form-actions">
          <button type="submit" disabled={saving}>
            {saving ? "Saving..." : editingId ? "Save changes" : "Add property"}
          </button>
          {editingId && (
            <button type="button" className="secondary" onClick={resetForm}>
              Cancel
            </button>
          )}
        </div>
      </form>

      <table className="properties-table">
        <thead>
          <tr>
            <th>Photo</th>
            <th>Title</th>
            <th>Bedrooms</th>
            <th>Budget</th>
            <th>Location</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {properties.map((p) => (
            <tr key={p.id}>
              <td>
                {p.imageUrl ? (
                  <img className="property-thumb" src={p.imageUrl} alt={p.title} />
                ) : (
                  <span className="empty-note">No photo</span>
                )}
              </td>
              <td>{p.title}</td>
              <td>{p.bedrooms}</td>
              <td>{p.budget}</td>
              <td>{p.location}</td>
              <td>
                <button onClick={() => startEdit(p)}>Edit</button>
                <button className="danger" onClick={() => handleDelete(p)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {properties.length === 0 && (
            <tr>
              <td colSpan={6} className="empty-note">
                No properties yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
