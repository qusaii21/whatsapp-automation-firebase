import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { db } from "../firebase.js";
import { formatDateTime, formatINR } from "../lib/format.js";

const STATUS_LABELS = {
  pending: "Pending",
  replied: "Replied",
  followed_up: "Followed Up",
  visit_requested: "Visit Requested",
  qualified: "Qualified",
};

export default function Insights() {
  const [leads, setLeads] = useState([]);
  const [sortKey, setSortKey] = useState("lastMessageAt");
  const [sortDir, setSortDir] = useState("desc");

  useEffect(() => {
    const q = query(collection(db, "leads"), orderBy("createdAt", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      setLeads(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
    });
    return unsubscribe;
  }, []);

  const sortedLeads = useMemo(() => {
    const rows = [...leads];
    rows.sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      if (av && typeof av.toDate === "function") av = av.toDate().getTime();
      if (bv && typeof bv.toDate === "function") bv = bv.toDate().getTime();
      if (av == null) av = sortDir === "asc" ? Infinity : -Infinity;
      if (bv == null) bv = sortDir === "asc" ? Infinity : -Infinity;
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return rows;
  }, [leads, sortKey, sortDir]);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  const columns = [
    { key: "name", label: "Name" },
    { key: "phone", label: "Phone" },
    { key: "status", label: "Status" },
    { key: "extractedBedrooms", label: "Bedrooms" },
    { key: "extractedBudget", label: "Budget" },
    { key: "preferredLocation", label: "Location" },
    { key: "timeline", label: "Timeline" },
    { key: "purpose", label: "Purpose" },
    { key: "interestLevel", label: "Interest" },
    { key: "financingRequired", label: "Financing" },
    { key: "propertyFound", label: "Property Shown" },
    { key: "visitRequested", label: "Visit Requested" },
    { key: "conversationEnded", label: "Conversation Ended" },
    { key: "lastMessageAt", label: "Last Message" },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Insights</h1>
          <div className="page-subtitle">Every lead's extracted data in one sortable table.</div>
        </div>
      </div>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} onClick={() => toggleSort(col.key)} title="Click to sort">
                  {col.label} {sortKey === col.key ? (sortDir === "asc" ? "▲" : "▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedLeads.map((lead) => (
              <tr key={lead.id}>
                <td>{lead.name || "—"}</td>
                <td>{lead.phone}</td>
                <td>{STATUS_LABELS[lead.status] || lead.status || "—"}</td>
                <td>{lead.extractedBedrooms ?? "—"}</td>
                <td>{lead.extractedBudget != null ? formatINR(lead.extractedBudget) : "—"}</td>
                <td>{lead.preferredLocation ?? "—"}</td>
                <td>{lead.timeline ?? "—"}</td>
                <td>{lead.purpose ?? "—"}</td>
                <td>{lead.interestLevel ?? "—"}</td>
                <td>{lead.financingRequired == null ? "—" : lead.financingRequired ? "Yes" : "No"}</td>
                <td>{lead.propertyFound ? "Yes" : "No"}</td>
                <td>{lead.visitRequested ? "Yes" : "No"}</td>
                <td>{lead.conversationEnded ? "Yes" : "No"}</td>
                <td>{formatDateTime(lead.lastMessageAt)}</td>
              </tr>
            ))}
            {sortedLeads.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="empty-note">
                  No leads yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
