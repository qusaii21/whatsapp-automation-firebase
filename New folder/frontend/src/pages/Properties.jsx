import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { addDoc, deleteDoc, onSnapshot, updateDoc } from "firebase/firestore";
import { getDownloadURL, ref, uploadBytes, deleteObject } from "firebase/storage";
import { Search, Plus, X, Star, BedDouble, Bath, Ruler, MapPin, Trash2, Pencil } from "lucide-react";
import { storage } from "../firebase.js";
import { propertiesCollection, propertyDoc } from "../lib/agencyPath.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import {
  PROPERTY_TYPES,
  LISTING_TYPES,
  FURNISHING_TYPES,
  FACING_OPTIONS,
  POSSESSION_STATUS,
  AMENITY_FIELDS,
  PUNE_LOCALITIES,
} from "../constants/propertyEnums.js";
import { formatINR } from "../lib/format.js";

const EMPTY_FORM = {
  projectName: "",
  builder: "",
  description: "",
  city: "Pune",
  locality: PUNE_LOCALITIES[0],
  microLocation: "",
  landmark: "",

  propertyType: "Apartment",
  listingType: "Sale",
  price: "",
  pricePerSqFt: "",
  maintenance: "",
  deposit: "",
  areaSqFt: "",
  carpetArea: "",
  superBuiltupArea: "",

  bedrooms: "",
  bathrooms: "",
  balconies: "",
  parkingCovered: "",
  parkingOpen: "",
  floor: "",
  totalFloors: "",
  facing: FACING_OPTIONS[0],
  furnishing: FURNISHING_TYPES[0],

  possessionStatus: POSSESSION_STATUS[0],
  possessionDate: "",
  ageOfProperty: "",

  reraApproved: false,
  reraNumber: "",

  schoolsNearby: "",
  hospitalsNearby: "",
  mallsNearby: "",
  metroNearby: "",
  busStopNearby: "",
  airportDistance: "",
  railwayDistance: "",

  builderRating: "",
  societyRating: "",

  ownerName: "",
  agentName: "",
  contactNumber: "",

  featured: false,
  premium: false,
  available: true,
};

function csvToArray(v) {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function Properties() {
  const { agencyId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [listingFilter, setListingFilter] = useState("all");

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [amenities, setAmenities] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [existingImages, setExistingImages] = useState([]);
  const [newImageFiles, setNewImageFiles] = useState([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!agencyId) {
      setProperties([]);
      setLoading(true);
      return undefined;
    }
    const unsubscribe = onSnapshot(
      propertiesCollection(agencyId),
      (snapshot) => {
        setProperties(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsubscribe;
  }, [agencyId]);

  // Deep link from the Dashboard's "Add Property" quick action.
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      openNew();
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return properties.filter((p) => {
      if (term) {
        const haystack = `${p.projectName || ""} ${p.locality || ""} ${p.builder || ""}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      if (typeFilter !== "all" && p.propertyType !== typeFilter) return false;
      if (listingFilter !== "all" && p.listingType !== listingFilter) return false;
      return true;
    });
  }, [properties, search, typeFilter, listingFilter]);

  function openNew() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setAmenities({});
    setExistingImages([]);
    setNewImageFiles([]);
    setDrawerOpen(true);
  }

  function openEdit(p) {
    setEditingId(p.id);
    setForm({
      ...EMPTY_FORM,
      ...Object.fromEntries(Object.keys(EMPTY_FORM).map((k) => [k, p[k] ?? EMPTY_FORM[k]])),
      schoolsNearby: (p.schoolsNearby || []).join(", "),
      hospitalsNearby: (p.hospitalsNearby || []).join(", "),
      mallsNearby: (p.mallsNearby || []).join(", "),
    });
    const amenityState = {};
    AMENITY_FIELDS.forEach(({ field }) => (amenityState[field] = !!p[field]));
    setAmenities(amenityState);
    setExistingImages(p.images || (p.imageUrl ? [p.imageUrl] : []));
    setNewImageFiles([]);
    setDrawerOpen(true);
  }

  function closeDrawer() {
    setDrawerOpen(false);
  }

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function toggleAmenity(field) {
    setAmenities((a) => ({ ...a, [field]: !a[field] }));
  }

  function removeExistingImage(url) {
    setExistingImages((imgs) => imgs.filter((u) => u !== url));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const uploadedUrls = [];
      for (const file of newImageFiles) {
        const storageRef = ref(storage, `property-photos/${Date.now()}-${file.name}`);
        await uploadBytes(storageRef, file);
        uploadedUrls.push(await getDownloadURL(storageRef));
      }
      const images = [...existingImages, ...uploadedUrls];

      const numeric = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

      const payload = {
        projectName: form.projectName.trim(),
        builder: form.builder.trim(),
        description: form.description.trim(),
        city: form.city.trim(),
        locality: form.locality,
        microLocation: form.microLocation.trim(),
        landmark: form.landmark.trim(),

        propertyType: form.propertyType,
        listingType: form.listingType,
        price: numeric(form.price) || 0,
        pricePerSqFt: numeric(form.pricePerSqFt),
        maintenance: numeric(form.maintenance),
        deposit: numeric(form.deposit),
        areaSqFt: numeric(form.areaSqFt),
        carpetArea: numeric(form.carpetArea),
        superBuiltupArea: numeric(form.superBuiltupArea),

        bedrooms: numeric(form.bedrooms) || 0,
        bathrooms: numeric(form.bathrooms) || 0,
        balconies: numeric(form.balconies) || 0,
        parkingCovered: numeric(form.parkingCovered) || 0,
        parkingOpen: numeric(form.parkingOpen) || 0,
        floor: numeric(form.floor) || 0,
        totalFloors: numeric(form.totalFloors) || 0,
        facing: form.facing,
        furnishing: form.furnishing,

        possessionStatus: form.possessionStatus,
        possessionDate: form.possessionDate || null,
        ageOfProperty: numeric(form.ageOfProperty),

        reraApproved: !!form.reraApproved,
        reraNumber: form.reraApproved ? form.reraNumber.trim() : null,

        ...amenities,

        schoolsNearby: csvToArray(form.schoolsNearby),
        hospitalsNearby: csvToArray(form.hospitalsNearby),
        mallsNearby: csvToArray(form.mallsNearby),
        metroNearby: numeric(form.metroNearby),
        busStopNearby: numeric(form.busStopNearby),
        airportDistance: numeric(form.airportDistance),
        railwayDistance: numeric(form.railwayDistance),

        builderRating: numeric(form.builderRating),
        societyRating: numeric(form.societyRating),

        images,
        ownerName: form.ownerName.trim() || null,
        agentName: form.agentName.trim() || null,
        contactNumber: form.contactNumber.trim() || null,

        featured: !!form.featured,
        premium: !!form.premium,
        available: !!form.available,

        updatedAt: new Date(),
      };

      if (!agencyId) return;
      if (editingId) {
        await updateDoc(propertyDoc(agencyId, editingId), payload);
      } else {
        await addDoc(propertiesCollection(agencyId), { ...payload, createdAt: new Date() });
      }
      closeDrawer();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(property) {
    if (!agencyId) return;
    if (!confirm(`Delete "${property.projectName}"?`)) return;
    for (const url of property.images || []) {
      try {
        await deleteObject(ref(storage, url));
      } catch {
        // best-effort cleanup only
      }
    }
    await deleteDoc(propertyDoc(agencyId, property.id));
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Properties</h1>
          <div className="page-subtitle">{properties.length} listings in inventory</div>
        </div>
        <button className="btn btn-primary" onClick={openNew}>
          <Plus size={15} /> Add property
        </button>
      </div>

      <div className="properties-toolbar">
        <div className="conv-search">
          <Search size={14} />
          <input type="text" placeholder="Search project, locality, builder..." value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="properties-filters">
          <select className="select" style={{ width: "auto" }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="all">All types</option>
            {PROPERTY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select className="select" style={{ width: "auto" }} value={listingFilter} onChange={(e) => setListingFilter(e.target.value)}>
            <option value="all">Sale & Rent</option>
            {LISTING_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading && (
        <div className="properties-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="property-card-v2">
              <div className="skeleton" style={{ height: 160 }} />
              <div className="property-card-v2-body">
                <div className="skeleton skeleton-line" style={{ width: "60%" }} />
                <div className="skeleton skeleton-line" style={{ width: "85%" }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No properties yet</div>
          <div className="empty-note">Add one manually, or run the seed script to populate ~50 realistic listings.</div>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="properties-grid">
          {filtered.map((p) => {
            const image = (p.images && p.images[0]) || p.imageUrl;
            return (
              <div className="property-card-v2" key={p.id}>
                <div className="property-card-v2-image">
                  {image ? <img src={image} alt={p.projectName} /> : <div className="empty-note" style={{ padding: 16 }}>No photo</div>}
                  <div className="property-card-v2-badges">
                    {p.featured && (
                      <span className="badge badge-warm">
                        <Star size={10} /> Featured
                      </span>
                    )}
                    {!p.available && <span className="badge badge-muted">Unavailable</span>}
                  </div>
                </div>
                <div className="property-card-v2-body">
                  <div className="property-card-v2-price">
                    {formatINR(p.price)}
                    {p.listingType === "Rent" ? "/mo" : ""}
                  </div>
                  <div className="property-card-v2-title">{p.projectName || "Untitled"}</div>
                  <div className="property-card-v2-loc">
                    <MapPin size={11} style={{ verticalAlign: -1 }} /> {p.locality}, {p.city}
                  </div>
                  <div className="property-card-v2-meta">
                    {p.bedrooms > 0 && (
                      <span>
                        <BedDouble size={12} style={{ verticalAlign: -2 }} /> {p.bedrooms}
                      </span>
                    )}
                    {p.bathrooms > 0 && (
                      <span>
                        <Bath size={12} style={{ verticalAlign: -2 }} /> {p.bathrooms}
                      </span>
                    )}
                    {p.carpetArea && (
                      <span>
                        <Ruler size={12} style={{ verticalAlign: -2 }} /> {p.carpetArea} sqft
                      </span>
                    )}
                  </div>
                  <div className="property-card-v2-actions">
                    <button className="btn btn-sm" style={{ flex: 1 }} onClick={() => openEdit(p)}>
                      <Pencil size={12} /> Edit
                    </button>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(p)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={closeDrawer} />
          <form className="drawer" onSubmit={handleSubmit}>
            <div className="drawer-header">
              <strong>{editingId ? "Edit property" : "Add property"}</strong>
              <button type="button" className="btn btn-icon btn-ghost" onClick={closeDrawer}>
                <X size={16} />
              </button>
            </div>

            <div className="drawer-body">
              <div className="form-section">
                <div className="form-section-title">Basics</div>
                <div className="form-grid">
                  <label className="form-full-width">
                    <span className="field-label">Project name</span>
                    <input className="input" required value={form.projectName} onChange={(e) => set("projectName", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Builder</span>
                    <input className="input" value={form.builder} onChange={(e) => set("builder", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Property type</span>
                    <select className="select" value={form.propertyType} onChange={(e) => set("propertyType", e.target.value)}>
                      {PROPERTY_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="field-label">Listing type</span>
                    <select className="select" value={form.listingType} onChange={(e) => set("listingType", e.target.value)}>
                      {LISTING_TYPES.map((t) => (
                        <option key={t}>{t}</option>
                      ))}
                    </select>
                  </label>
                  <label className="form-full-width">
                    <span className="field-label">Description</span>
                    <textarea className="textarea" rows={3} value={form.description} onChange={(e) => set("description", e.target.value)} />
                  </label>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">Location</div>
                <div className="form-grid">
                  <label>
                    <span className="field-label">City</span>
                    <input className="input" value={form.city} onChange={(e) => set("city", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Locality</span>
                    <select className="select" value={form.locality} onChange={(e) => set("locality", e.target.value)}>
                      {PUNE_LOCALITIES.map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="field-label">Micro-location</span>
                    <input className="input" value={form.microLocation} onChange={(e) => set("microLocation", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Landmark</span>
                    <input className="input" value={form.landmark} onChange={(e) => set("landmark", e.target.value)} />
                  </label>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">Pricing &amp; area</div>
                <div className="form-grid">
                  <label>
                    <span className="field-label">Price {form.listingType === "Rent" ? "(monthly rent)" : ""}</span>
                    <input className="input" type="number" required value={form.price} onChange={(e) => set("price", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Price / sqft</span>
                    <input className="input" type="number" value={form.pricePerSqFt} onChange={(e) => set("pricePerSqFt", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Maintenance (monthly)</span>
                    <input className="input" type="number" value={form.maintenance} onChange={(e) => set("maintenance", e.target.value)} />
                  </label>
                  {form.listingType === "Rent" && (
                    <label>
                      <span className="field-label">Security deposit</span>
                      <input className="input" type="number" value={form.deposit} onChange={(e) => set("deposit", e.target.value)} />
                    </label>
                  )}
                  <label>
                    <span className="field-label">Carpet area (sqft)</span>
                    <input className="input" type="number" value={form.carpetArea} onChange={(e) => set("carpetArea", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Super built-up area (sqft)</span>
                    <input className="input" type="number" value={form.superBuiltupArea} onChange={(e) => set("superBuiltupArea", e.target.value)} />
                  </label>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">Specifications</div>
                <div className="form-grid">
                  <label>
                    <span className="field-label">Bedrooms</span>
                    <input className="input" type="number" min="0" value={form.bedrooms} onChange={(e) => set("bedrooms", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Bathrooms</span>
                    <input className="input" type="number" min="0" value={form.bathrooms} onChange={(e) => set("bathrooms", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Balconies</span>
                    <input className="input" type="number" min="0" value={form.balconies} onChange={(e) => set("balconies", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Covered parking</span>
                    <input className="input" type="number" min="0" value={form.parkingCovered} onChange={(e) => set("parkingCovered", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Open parking</span>
                    <input className="input" type="number" min="0" value={form.parkingOpen} onChange={(e) => set("parkingOpen", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Floor</span>
                    <input className="input" type="number" min="0" value={form.floor} onChange={(e) => set("floor", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Total floors</span>
                    <input className="input" type="number" min="0" value={form.totalFloors} onChange={(e) => set("totalFloors", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Facing</span>
                    <select className="select" value={form.facing} onChange={(e) => set("facing", e.target.value)}>
                      {FACING_OPTIONS.map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="field-label">Furnishing</span>
                    <select className="select" value={form.furnishing} onChange={(e) => set("furnishing", e.target.value)}>
                      {FURNISHING_TYPES.map((f) => (
                        <option key={f}>{f}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">Possession &amp; RERA</div>
                <div className="form-grid">
                  <label>
                    <span className="field-label">Possession status</span>
                    <select className="select" value={form.possessionStatus} onChange={(e) => set("possessionStatus", e.target.value)}>
                      {POSSESSION_STATUS.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  {form.possessionStatus === "Under Construction" ? (
                    <label>
                      <span className="field-label">Possession date</span>
                      <input className="input" type="date" value={form.possessionDate || ""} onChange={(e) => set("possessionDate", e.target.value)} />
                    </label>
                  ) : (
                    <label>
                      <span className="field-label">Age of property (years)</span>
                      <input className="input" type="number" min="0" value={form.ageOfProperty} onChange={(e) => set("ageOfProperty", e.target.value)} />
                    </label>
                  )}
                  <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 20 }}>
                    <input type="checkbox" checked={form.reraApproved} onChange={(e) => set("reraApproved", e.target.checked)} />
                    <span className="field-label" style={{ margin: 0 }}>RERA approved</span>
                  </label>
                  {form.reraApproved && (
                    <label>
                      <span className="field-label">RERA number</span>
                      <input className="input" value={form.reraNumber} onChange={(e) => set("reraNumber", e.target.value)} />
                    </label>
                  )}
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">Amenities</div>
                <div className="amenity-chip-grid">
                  {AMENITY_FIELDS.map(({ field, label }) => (
                    <button
                      type="button"
                      key={field}
                      className={"amenity-chip" + (amenities[field] ? " active" : "")}
                      onClick={() => toggleAmenity(field)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">Nearby &amp; ratings</div>
                <div className="form-grid">
                  <label className="form-full-width">
                    <span className="field-label">Schools nearby (comma separated)</span>
                    <input className="input" value={form.schoolsNearby} onChange={(e) => set("schoolsNearby", e.target.value)} />
                  </label>
                  <label className="form-full-width">
                    <span className="field-label">Hospitals nearby (comma separated)</span>
                    <input className="input" value={form.hospitalsNearby} onChange={(e) => set("hospitalsNearby", e.target.value)} />
                  </label>
                  <label className="form-full-width">
                    <span className="field-label">Malls nearby (comma separated)</span>
                    <input className="input" value={form.mallsNearby} onChange={(e) => set("mallsNearby", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Metro distance (km)</span>
                    <input className="input" type="number" step="0.1" value={form.metroNearby} onChange={(e) => set("metroNearby", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Airport distance (km)</span>
                    <input className="input" type="number" step="0.1" value={form.airportDistance} onChange={(e) => set("airportDistance", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Builder rating (0-5)</span>
                    <input className="input" type="number" step="0.1" min="0" max="5" value={form.builderRating} onChange={(e) => set("builderRating", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Society rating (0-5)</span>
                    <input className="input" type="number" step="0.1" min="0" max="5" value={form.societyRating} onChange={(e) => set("societyRating", e.target.value)} />
                  </label>
                </div>
              </div>

              <div className="form-section">
                <div className="form-section-title">Contact &amp; visibility</div>
                <div className="form-grid">
                  <label>
                    <span className="field-label">Agent name</span>
                    <input className="input" value={form.agentName} onChange={(e) => set("agentName", e.target.value)} />
                  </label>
                  <label>
                    <span className="field-label">Contact number</span>
                    <input className="input" value={form.contactNumber} onChange={(e) => set("contactNumber", e.target.value)} />
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={form.featured} onChange={(e) => set("featured", e.target.checked)} />
                    <span className="field-label" style={{ margin: 0 }}>Featured</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={form.premium} onChange={(e) => set("premium", e.target.checked)} />
                    <span className="field-label" style={{ margin: 0 }}>Premium</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input type="checkbox" checked={form.available} onChange={(e) => set("available", e.target.checked)} />
                    <span className="field-label" style={{ margin: 0 }}>Available (shown to the AI agent)</span>
                  </label>
                </div>
              </div>

              <div className="form-section" style={{ marginBottom: 0 }}>
                <div className="form-section-title">Photos</div>
                {existingImages.length > 0 && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                    {existingImages.map((url) => (
                      <div key={url} style={{ position: "relative" }}>
                        <img src={url} alt="" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }} />
                        <button
                          type="button"
                          onClick={() => removeExistingImage(url)}
                          style={{
                            position: "absolute",
                            top: -6,
                            right: -6,
                            width: 20,
                            height: 20,
                            borderRadius: "50%",
                            border: "none",
                            background: "var(--danger)",
                            color: "#fff",
                            cursor: "pointer",
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(e) => setNewImageFiles(Array.from(e.target.files || []))}
                />
              </div>
            </div>

            <div className="drawer-footer">
              <button type="button" className="btn" onClick={closeDrawer}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving..." : editingId ? "Save changes" : "Add property"}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
