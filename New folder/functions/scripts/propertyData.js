// Deterministic-ish generator for ~50 realistic Pune property listings.
// Used only by scripts/seedProperties.js (never imported by the deployed
// Cloud Functions), so it's fine for this to be a bit "loose" JS.

const {
  PROPERTY_TYPES,
  LISTING_TYPES,
  FURNISHING_TYPES,
  FACING_OPTIONS,
  POSSESSION_STATUS,
  AMENITY_FIELDS,
  PUNE_LOCALITIES,
} = require("../src/propertyEnums");

// Small mulberry32 PRNG so re-running the script produces a stable, review-
// able dataset instead of a new random set every time (easier to sanity
// check diffs / screenshots). Swap the seed to get a different batch.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BUILDERS = [
  "Kolte-Patil Developers",
  "Godrej Properties",
  "Kumar Properties",
  "Goel Ganga Developments",
  "Nyati Group",
  "VTP Realty",
  "Panchshil Realty",
  "Rohan Builders",
  "Paranjape Schemes",
  "Amanora Park Town",
  "Pride Group",
  "Gera Developments",
  "Mantra Properties",
  "Kohinoor Group",
  "Vilas Javdekar Developers",
];

const PROJECT_PREFIXES = [
  "Green Valley",
  "Sky Heights",
  "Palm Springs",
  "Orchid Woods",
  "The Address",
  "Emerald Bay",
  "Willow Park",
  "Silver Oak",
  "Meadow Crest",
  "Elysium",
  "Riviera",
  "Zenith",
  "Aurum",
  "Belmonte",
  "Grandeur",
  "Horizon",
  "Serenity",
  "Amber Court",
  "Whitefield Residency",
  "Cedar Grove",
];

const LOCALITY_META = {
  Baner: { city: "Pune", tier: "premium", lat: 18.5590, lng: 73.7868, landmarks: ["Baner Road", "Balewadi High Street"] },
  Balewadi: { city: "Pune", tier: "premium", lat: 18.5716, lng: 73.7702, landmarks: ["Balewadi Stadium", "Sus Road"] },
  Wakad: { city: "Pune", tier: "mid", lat: 18.5993, lng: 73.7629, landmarks: ["Mumbai-Bangalore Highway", "Wakad Bridge"] },
  Hinjewadi: { city: "Pune", tier: "mid", lat: 18.5912, lng: 73.7389, landmarks: ["Rajiv Gandhi Infotech Park", "Hinjewadi Phase 2"] },
  Kharadi: { city: "Pune", tier: "premium", lat: 18.5514, lng: 73.9430, landmarks: ["EON IT Park", "World Trade Center"] },
  NIBM: { city: "Pune", tier: "mid", lat: 18.4633, lng: 73.8935, landmarks: ["NIBM Road", "Lohegaon Road"] },
  Kondhwa: { city: "Pune", tier: "affordable", lat: 18.4667, lng: 73.8926, landmarks: ["Kondhwa Bus Depot", "Salunke Vihar Road"] },
  "Viman Nagar": { city: "Pune", tier: "premium", lat: 18.5679, lng: 73.9143, landmarks: ["Phoenix Marketcity", "Pune Airport"] },
  "Koregaon Park": { city: "Pune", tier: "luxury", lat: 18.5362, lng: 73.8938, landmarks: ["North Main Road", "Osho Ashram"] },
  Hadapsar: { city: "Pune", tier: "mid", lat: 18.5089, lng: 73.9260, landmarks: ["Magarpatta City", "Amanora Mall"] },
  Magarpatta: { city: "Pune", tier: "premium", lat: 18.5158, lng: 73.9296, landmarks: ["Magarpatta Cybercity", "Seasons Mall"] },
  Kothrud: { city: "Pune", tier: "mid", lat: 18.5074, lng: 73.8077, landmarks: ["Kothrud Depot", "Karve Road"] },
  Pashan: { city: "Pune", tier: "mid", lat: 18.5372, lng: 73.7924, landmarks: ["Pashan Lake", "NCL Pune"] },
  Bavdhan: { city: "Pune", tier: "mid", lat: 18.5108, lng: 73.7729, landmarks: ["Bavdhan Gaothan", "Paud Road"] },
  Shivajinagar: { city: "Pune", tier: "mid", lat: 18.5304, lng: 73.8477, landmarks: ["Pune Railway Station", "FC Road"] },
  Aundh: { city: "Pune", tier: "premium", lat: 18.5643, lng: 73.8077, landmarks: ["Aundh ITI Road", "Parihar Chowk"] },
  Camp: { city: "Pune", tier: "mid", lat: 18.5122, lng: 73.8797, landmarks: ["MG Road", "East Street"] },
  "Sinhagad Road": { city: "Pune", tier: "affordable", lat: 18.4740, lng: 73.8241, landmarks: ["Vadgaon Bridge", "Dattawadi"] },
  Warje: { city: "Pune", tier: "affordable", lat: 18.4802, lng: 73.8065, landmarks: ["Warje Malwadi", "NDA Road"] },
  Undri: { city: "Pune", tier: "affordable", lat: 18.4423, lng: 73.9182, landmarks: ["Pisoli Road", "Handewadi Road"] },
};

const SCHOOL_POOL = [
  "Vibgyor High School",
  "Delhi Public School Pune",
  "Symbiosis International School",
  "Mercedes-Benz International School",
  "The Bishop's School",
  "Euro School",
  "Orchid School",
  "Vidya Valley School",
];

const HOSPITAL_POOL = [
  "Ruby Hall Clinic",
  "Sahyadri Hospital",
  "Jehangir Hospital",
  "Columbia Asia Hospital",
  "Aditya Birla Memorial Hospital",
  "Noble Hospital",
  "Manipal Hospital",
];

const MALL_POOL = [
  "Phoenix Marketcity",
  "Seasons Mall",
  "Amanora Mall",
  "Westend Mall",
  "Pavilion Mall",
  "Kumar Pacific Mall",
];

const DESCRIPTION_TEMPLATES = [
  "A {furnishing_lc} {bhk} in the heart of {locality}, offering {facing} exposure and a {possession_lc} possession timeline. Built by {builder}, this {propertyTypeLc} is designed for modern urban living with easy access to {landmark}.",
  "Spacious {bhk} {propertyTypeLc} in {locality}, ideal for {purposeHint}. {builder} has focused on natural light and ventilation, with {facing} facing and proximity to {landmark}.",
  "This {possession_lc} {bhk} by {builder} sits in one of {locality}'s most sought-after pockets, close to {landmark}. Thoughtful layout, {furnishing_lc} interiors, and strong connectivity make it a practical choice.",
  "Premium {bhk} {propertyTypeLc} in {locality} with a well-planned {facing}-facing layout. Walking distance to {landmark}, with {builder}'s signature focus on amenities and long-term value.",
];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function pickSome(rng, arr, min, max) {
  const count = min + Math.floor(rng() * (max - min + 1));
  const shuffled = [...arr].sort(() => rng() - 0.5);
  return shuffled.slice(0, count);
}

function round(n, decimals = 0) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function jitter(rng, base, pct) {
  return base * (1 + (rng() - 0.5) * 2 * pct);
}

/**
 * Generates `count` realistic Pune property listings.
 * @param {number} count
 * @param {number} seed
 * @returns {object[]} plain objects ready to be written to Firestore (no `id` — Firestore assigns it)
 */
function generateProperties(count = 50, seed = 42) {
  const rng = mulberry32(seed);
  const properties = [];

  for (let i = 0; i < count; i++) {
    const locality = pick(rng, PUNE_LOCALITIES);
    const meta = LOCALITY_META[locality];
    const builder = pick(rng, BUILDERS);
    const projectName = `${pick(rng, PROJECT_PREFIXES)} ${pick(rng, ["Residency", "Enclave", "Towers", "Phase 2", "County", "Heights", ""])}`.trim();

    // Weight property types: mostly apartments, some villas/row houses, a few plots/commercial.
    const typeRoll = rng();
    let propertyType;
    if (typeRoll < 0.62) propertyType = "Apartment";
    else if (typeRoll < 0.75) propertyType = "Villa";
    else if (typeRoll < 0.85) propertyType = "Row House";
    else if (typeRoll < 0.92) propertyType = "Plot";
    else if (typeRoll < 0.97) propertyType = "Office";
    else propertyType = "Commercial";

    // ~30% rentals, rest for sale — rentals skew toward apartments/studios.
    const listingType = rng() < 0.3 ? "Rent" : "Sale";

    let bedrooms, bathrooms, balconies, carpetArea;
    if (propertyType === "Plot") {
      bedrooms = 0;
      bathrooms = 0;
      balconies = 0;
      carpetArea = round(jitter(rng, 2400, 0.5));
    } else if (propertyType === "Office" || propertyType === "Commercial") {
      bedrooms = 0;
      bathrooms = pick(rng, [1, 2]);
      balconies = 0;
      carpetArea = round(jitter(rng, 1200, 0.6));
    } else if (propertyType === "Studio") {
      bedrooms = 1;
      bathrooms = 1;
      balconies = pick(rng, [0, 1]);
      carpetArea = round(jitter(rng, 450, 0.15));
    } else {
      bedrooms = pick(rng, propertyType === "Apartment" ? [1, 2, 2, 3, 3, 4] : [3, 4, 4, 5]);
      bathrooms = Math.max(1, bedrooms - pick(rng, [0, 1]));
      balconies = pick(rng, [1, 1, 2, 2, 3]);
      const perBhkArea = propertyType === "Apartment" ? 480 : 700;
      carpetArea = round(jitter(rng, bedrooms * perBhkArea + 150, 0.12));
    }

    const superBuiltupArea = round(carpetArea * jitter(rng, 1.28, 0.05));
    const areaSqFt = superBuiltupArea;

    // Price per sqft driven by locality tier + listing type.
    const tierBasePsf = { luxury: 16500, premium: 11500, mid: 8200, affordable: 6000 }[meta.tier];
    const pricePerSqFt = Math.round(jitter(rng, tierBasePsf, 0.15));

    let price, deposit, maintenance;
    if (listingType === "Rent") {
      const tierBaseRentPsf = { luxury: 48, premium: 32, mid: 22, affordable: 15 }[meta.tier];
      price = Math.round(jitter(rng, superBuiltupArea * tierBaseRentPsf, 0.2) / 500) * 500;
      deposit = price * pick(rng, [3, 6, 10]);
      maintenance = Math.round(jitter(rng, superBuiltupArea * 2.5, 0.2) / 100) * 100;
    } else {
      price = Math.round((superBuiltupArea * pricePerSqFt) / 10000) * 10000;
      deposit = 0;
      maintenance = Math.round(jitter(rng, superBuiltupArea * 3, 0.2) / 100) * 100;
    }

    const possessionStatus = pick(rng, POSSESSION_STATUS);
    const ageOfProperty = possessionStatus === "Ready to Move" ? pick(rng, [0, 1, 2, 3, 5, 8]) : 0;
    const possessionDate =
      possessionStatus === "Under Construction"
        ? new Date(Date.now() + Math.round(jitter(rng, 540, 0.5)) * 24 * 3600 * 1000).toISOString().slice(0, 10)
        : null;

    const furnishing = pick(rng, FURNISHING_TYPES);
    const facing = pick(rng, FACING_OPTIONS);
    const totalFloors = propertyType === "Villa" || propertyType === "Row House" || propertyType === "Plot" ? 0 : pick(rng, [4, 7, 9, 12, 14, 18, 22]);
    const floor = totalFloors > 0 ? 1 + Math.floor(rng() * totalFloors) : 0;

    const reraApproved = propertyType !== "Plot" ? rng() < 0.85 : rng() < 0.4;

    const amenities = {};
    for (const field of AMENITY_FIELDS) {
      // Apartments/villas in premium/luxury tiers get richer amenities.
      const baseChance = { luxury: 0.85, premium: 0.7, mid: 0.5, affordable: 0.3 }[meta.tier];
      amenities[field] = propertyType === "Plot" ? false : rng() < baseChance;
    }
    // Security/lift/power backup are near-universal for apartments.
    if (propertyType === "Apartment" || propertyType === "Office" || propertyType === "Commercial") {
      amenities.security = rng() < 0.95;
      amenities.lift = rng() < 0.92;
      amenities.powerBackup = rng() < 0.88;
    }

    const template = pick(rng, DESCRIPTION_TEMPLATES);
    const bhkLabel = propertyType === "Plot" ? `${carpetArea} sq.ft plot` : propertyType === "Office" || propertyType === "Commercial" ? `${carpetArea} sq.ft ${propertyType.toLowerCase()} space` : `${bedrooms} BHK`;
    const description = template
      .replaceAll("{bhk}", bhkLabel)
      .replaceAll("{locality}", locality)
      .replaceAll("{facing}", facing)
      .replaceAll("{possession_lc}", possessionStatus.toLowerCase())
      .replaceAll("{builder}", builder)
      .replaceAll("{propertyTypeLc}", propertyType.toLowerCase())
      .replaceAll("{furnishing_lc}", furnishing.toLowerCase())
      .replaceAll("{purposeHint}", listingType === "Rent" ? "professionals or small families" : "end-use or long-term investment")
      .replaceAll("{landmark}", pick(rng, meta.landmarks));

    const imageSeed = `${locality}-${i}`.replace(/\s+/g, "-").toLowerCase();
    const images = Array.from({ length: 3 + Math.floor(rng() * 3) }, (_, idx) =>
      `https://picsum.photos/seed/${imageSeed}-${idx}/1200/800`
    );

    const now = new Date();
    const createdDaysAgo = Math.floor(rng() * 240);

    properties.push({
      projectName,
      builder,
      description,
      city: meta.city,
      locality,
      microLocation: pick(rng, meta.landmarks),
      landmark: pick(rng, meta.landmarks),
      latitude: round(meta.lat + (rng() - 0.5) * 0.01, 6),
      longitude: round(meta.lng + (rng() - 0.5) * 0.01, 6),

      propertyType,
      listingType,
      price,
      pricePerSqFt: propertyType === "Plot" ? Math.round(price / carpetArea) : pricePerSqFt,
      maintenance,
      deposit,
      areaSqFt,
      carpetArea,
      superBuiltupArea,

      bedrooms,
      bathrooms,
      balconies,
      parkingCovered: propertyType === "Plot" ? 0 : pick(rng, [0, 1, 1, 2]),
      parkingOpen: propertyType === "Plot" ? 0 : pick(rng, [0, 0, 1]),

      floor,
      totalFloors,
      facing,
      furnishing: propertyType === "Plot" ? "Unfurnished" : furnishing,

      possessionStatus,
      possessionDate,
      ageOfProperty,

      reraApproved,
      reraNumber: reraApproved ? `P52100${Math.floor(10000 + rng() * 89999)}` : null,

      ...amenities,

      schoolsNearby: pickSome(rng, SCHOOL_POOL, 1, 3),
      hospitalsNearby: pickSome(rng, HOSPITAL_POOL, 1, 2),
      mallsNearby: pickSome(rng, MALL_POOL, 1, 2),
      metroNearby: round(jitter(rng, 2.5, 0.6), 1),
      busStopNearby: round(jitter(rng, 0.4, 0.7), 1),
      airportDistance: round(jitter(rng, 14, 0.5), 1),
      railwayDistance: round(jitter(rng, 9, 0.5), 1),

      builderRating: round(3.5 + rng() * 1.5, 1),
      societyRating: round(3.3 + rng() * 1.6, 1),

      images,
      videos: rng() < 0.3 ? [`https://example.com/videos/${imageSeed}.mp4`] : [],
      brochure: rng() < 0.6 ? `https://example.com/brochures/${imageSeed}.pdf` : null,
      floorPlan: rng() < 0.7 ? `https://example.com/floorplans/${imageSeed}.pdf` : null,
      tour360: rng() < 0.2 ? `https://example.com/tours/${imageSeed}` : null,

      featured: rng() < 0.15,
      premium: meta.tier === "luxury" || meta.tier === "premium",
      available: rng() < 0.92,

      ownerName: listingType === "Rent" ? pick(rng, ["Mr. Deshmukh", "Mrs. Kulkarni", "Mr. Joshi", "Mrs. Patil", "Mr. Rane"]) : null,
      agentName: pick(rng, ["Aditi Sharma", "Rohan Mehta", "Sneha Kulkarni", "Vikram Rao", "Priya Nair"]),
      contactNumber: `+91 9${Math.floor(100000000 + rng() * 899999999)}`,

      createdAt: new Date(now.getTime() - createdDaysAgo * 24 * 3600 * 1000),
      updatedAt: now,
    });
  }

  return properties;
}

module.exports = { generateProperties };
