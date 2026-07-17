import { useEffect, useState } from "react";
import { collection, documentId, onSnapshot, query, where } from "firebase/firestore";
import { metricsDashboardDoc, metricsDailyDoc, metricsMonthlyDoc, agencyCollection } from "./agencyPath.js";
import { dayKey, lastNDayKeys, monthKey } from "./metricsPeriods.js";

/**
 * Reads exactly what the dashboard needs from the metrics engine, and
 * nothing more:
 *   - `metrics/dashboard`        — one doc, all-time counters
 *   - `metricsDaily/{today}`     — one doc, today's counters
 *   - `metricsMonthly/{month}`   — one doc, this month's counters
 *   - `metricsDaily` (14 docs)   — bounded `documentId() in [...]` query for
 *     the last 14 days, powering the trend charts. Never grows past 14 docs
 *     no matter how much history the CRM accumulates.
 *
 * All four are `onSnapshot` listeners (not one-time reads) so the dashboard
 * updates live as campaigns send, replies come in, etc. — the same
 * always-live posture the rest of this CRM already uses (Campaigns.jsx,
 * Templates.jsx, Insights.jsx). Four listeners total, each on a single doc
 * or a 14-doc bound — not a scan of any collection.
 */
export function useDashboardMetrics(agencyId) {
  const [allTime, setAllTime] = useState(null);
  const [allTimeLoading, setAllTimeLoading] = useState(true);

  const [today, setToday] = useState(null);
  const [todayLoading, setTodayLoading] = useState(true);

  const [month, setMonth] = useState(null);
  const [monthLoading, setMonthLoading] = useState(true);

  const [series, setSeries] = useState([]);
  const [seriesLoading, setSeriesLoading] = useState(true);

  useEffect(() => {
    if (!agencyId) {
      setAllTime(null);
      setAllTimeLoading(true);
      return undefined;
    }
    const unsub = onSnapshot(
      metricsDashboardDoc(agencyId),
      (snap) => {
        setAllTime(snap.exists() ? snap.data() : {});
        setAllTimeLoading(false);
      },
      () => setAllTimeLoading(false)
    );
    return unsub;
  }, [agencyId]);

  useEffect(() => {
    if (!agencyId) {
      setToday(null);
      setTodayLoading(true);
      return undefined;
    }
    const unsub = onSnapshot(
      metricsDailyDoc(agencyId, dayKey()),
      (snap) => {
        setToday(snap.exists() ? snap.data() : {});
        setTodayLoading(false);
      },
      () => setTodayLoading(false)
    );
    return unsub;
  }, [agencyId]);

  useEffect(() => {
    if (!agencyId) {
      setMonth(null);
      setMonthLoading(true);
      return undefined;
    }
    const unsub = onSnapshot(
      metricsMonthlyDoc(agencyId, monthKey()),
      (snap) => {
        setMonth(snap.exists() ? snap.data() : {});
        setMonthLoading(false);
      },
      () => setMonthLoading(false)
    );
    return unsub;
  }, [agencyId]);

  useEffect(() => {
    if (!agencyId) {
      setSeries([]);
      setSeriesLoading(true);
      return undefined;
    }
    const keys = lastNDayKeys(14);
    const q = query(agencyCollection(agencyId, "metricsDaily"), where(documentId(), "in", keys));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const byKey = {};
        snap.docs.forEach((d) => (byKey[d.id] = d.data()));
        // Always return all 14 keys in order, even ones with no doc yet
        // (no events that day) — so charts render a full, evenly-spaced
        // axis instead of collapsing gaps.
        setSeries(keys.map((key) => ({ key, ...byKey[key] })));
        setSeriesLoading(false);
      },
      () => setSeriesLoading(false)
    );
    return unsub;
  }, [agencyId]);

  return {
    allTime: allTime || {},
    allTimeLoading,
    today: today || {},
    todayLoading,
    month: month || {},
    monthLoading,
    series,
    seriesLoading,
  };
}
