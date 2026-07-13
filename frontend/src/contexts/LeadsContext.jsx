import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { db } from "../firebase.js";

/**
 * LEADS CONTEXT
 * ---------------------------------------------------------------------------
 * Before this existed, five separate places in the app each opened their own
 * independent `onSnapshot(collection(db, "leads"))` listener: ChatCRM,
 * Insights, SmartLeads, and two inside CampaignRecipients.jsx. Every one of
 * those listeners is billed a Firestore read every time ANY lead document
 * changes, so with several of them mounted at once (very likely — ChatCRM is
 * the home route) one inbound WhatsApp message could multiply into several
 * chargeable reads instead of one.
 *
 * This provider opens exactly ONE unbounded `leads` listener for the whole
 * app session and every consumer below reads from it via `useLeads()`
 * instead of subscribing itself. No `orderBy` is applied here on purpose —
 * Firestore's `orderBy` silently drops any document missing that field
 * (see lib/format.js's sortByRecency comment), so each consumer sorts
 * client-side with sortByRecency the same way the rest of this codebase
 * already does. This changes nothing about what any page displays.
 */
const LeadsContext = createContext({ leads: [], loading: true, leadsById: new Map() });

export function LeadsProvider({ children }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "leads"),
      (snapshot) => {
        setLeads(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsubscribe;
  }, []);

  const leadsById = useMemo(() => {
    const map = new Map();
    for (const lead of leads) map.set(lead.id, lead);
    return map;
  }, [leads]);

  const value = useMemo(() => ({ leads, loading, leadsById }), [leads, loading, leadsById]);

  return <LeadsContext.Provider value={value}>{children}</LeadsContext.Provider>;
}

export function useLeads() {
  return useContext(LeadsContext);
}
