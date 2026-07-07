# Meta Lead → WhatsApp AI Agent → CRM

Firebase project: Cloud Functions (2nd gen) handle the Facebook Lead Ads + WhatsApp
webhooks and run a LangChain.js + Groq agent; a small React CRM on Firebase Hosting
manages leads and property listings, talking to Firestore/Storage directly.

## Project layout

```
firebase.json
.firebaserc
firestore.rules
firestore.indexes.json
storage.rules
functions/
  package.json
  index.js                  # exports all 3 HTTPS functions
  src/
    config.js                # secret + constant declarations
    whatsapp.js               # WhatsApp Cloud API send helpers
    cloudTasks.js             # one-time 24h follow-up task scheduling
    agent.js                  # LangChain.js agent (Groq + property search tool)
    leadsWebhook.js            # Meta Lead Ads webhook
    followupCheck.js           # Cloud Tasks target, one-shot follow-up
    whatsappWebhook.js         # WhatsApp inbound messages -> agent -> reply
frontend/
  package.json / vite.config.js / index.html / .env.example
  src/
    firebase.js                # Firebase client SDK init
    App.jsx, main.jsx
    components/Sidebar.jsx, ConversationThread.jsx
    pages/Leads.jsx, Properties.jsx
    index.css
```

## 1. One-time GCP/Firebase setup

```bash
firebase login
firebase use --add          # pick/link your Firebase project, set as "default"
```

Enable the Cloud Tasks API (needed for the 24h follow-up scheduling) and create the
queue that `followupCheck` is targeted through:

```bash
gcloud services enable cloudtasks.googleapis.com --project=YOUR_FIREBASE_PROJECT_ID

gcloud tasks queues create followup-queue \
  --location=us-central1 \
  --project=YOUR_FIREBASE_PROJECT_ID
```

Also update `.firebaserc` with your actual project id in place of
`YOUR_FIREBASE_PROJECT_ID`.

## 2. Set function secrets

Each of these becomes available inside the Cloud Functions via
`SECRET_NAME.value()` (already wired up in `src/config.js`):

```bash
firebase functions:secrets:set FB_VERIFY_TOKEN
firebase functions:secrets:set FB_PAGE_ACCESS_TOKEN
firebase functions:secrets:set WHATSAPP_TOKEN
firebase functions:secrets:set WHATSAPP_PHONE_NUMBER_ID
firebase functions:secrets:set WHATSAPP_WELCOME_TEMPLATE
firebase functions:secrets:set WHATSAPP_FOLLOWUP_TEMPLATE
firebase functions:secrets:set GROQ_API_KEY
```

Each command prompts you to paste the value; it's stored in Secret Manager, not in
source control.

## 3. Frontend environment

```bash
cd frontend
cp .env.example .env.local
# fill in .env.local with your Firebase web app config
npm install
npm run build
cd ..
```

## 4. Install function dependencies

```bash
cd functions
npm install
cd ..
```

## 5. Deploy, in order

```bash
# Rules first
firebase deploy --only firestore:rules,storage:rules

# Functions (this is what registers the Cloud Run services the webhooks hit)
firebase deploy --only functions

# Hosting (serves the built React CRM)
firebase deploy --only hosting
```

Or all at once after the first successful run: `firebase deploy`.

## 6. Wire up Meta + WhatsApp webhooks

After `firebase deploy --only functions`, note the printed URLs for
`leadsWebhook` and `whatsappWebhook` (they follow the pattern
`https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/leadsWebhook`).

- In the Meta App dashboard, under **Webhooks > Page**, subscribe to the
  `leadgen` field and point it at the `leadsWebhook` URL, using the same value
  you set for `FB_VERIFY_TOKEN`.
- Under **WhatsApp > Configuration**, point the webhook at the `whatsappWebhook`
  URL, subscribed to the `messages` field, using the same `FB_VERIFY_TOKEN`
  value for verification.
- `followupCheck` is never called by Meta/WhatsApp directly — only by the Cloud
  Tasks queue created in step 1 — so it doesn't need to be registered anywhere.

## Notes / known trade-offs

- **No authentication in front of the CRM**, per the project spec ("no extra
  services, no extra layers"). Firestore/Storage rules are intentionally open
  so the browser-based CRM can read/write directly. See the comments at the
  top of `firestore.rules` and `storage.rules` — if this ever needs to be more
  than an internal tool, add Firebase Authentication and tighten those rules.
- `leadsWebhook` and `whatsappWebhook` always return HTTP 200 even on internal
  errors (logged via `firebase-functions/logger`) so Meta/WhatsApp don't
  retry-storm the endpoint; check `firebase functions:log` when debugging.
- `followupCheck` is deployed with `invoker: "private"`, so only the OIDC
  token minted by the Cloud Task (as the App Engine default service account)
  can call it — it's not reachable from the open internet.
