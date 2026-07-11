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

Enable the Cloud Tasks API and create BOTH queues this project needs — one for the
24h lead follow-up, one for fast async processing of incoming WhatsApp messages:

```bash
gcloud services enable cloudtasks.googleapis.com --project=YOUR_FIREBASE_PROJECT_ID

gcloud tasks queues create followup-queue \
  --location=us-central1 \
  --project=YOUR_FIREBASE_PROJECT_ID

gcloud tasks queues create message-processing-queue \
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
- **`whatsappWebhook` is intentionally thin.** It only verifies the message
  hasn't already been enqueued (via an atomic Firestore transaction on
  `processedMessages/{message.id}`) and hands off to `processIncomingMessage`
  through Cloud Tasks, then returns 200 immediately. This matters because
  Meta redelivers a webhook event if it doesn't get a fast 200 back, which
  would otherwise cause the AI agent to run — and reply — more than once for
  a single incoming message. All the actual work (Firestore updates, the LLM
  call, sending the WhatsApp reply and any property photo) happens in
  `processIncomingMessage`, which runs asynchronously and can safely take a
  few seconds without triggering a duplicate delivery.
- `processIncomingMessage` is deployed with `invoker: "private"`, same as
  `followupCheck` — only Cloud Tasks (via its OIDC token) can call it.
- **Conversation-end detection**: the agent's structured output includes a
  `conversationEnded` boolean, but it's now scoped correctly — it's only true
  when the user signals the *entire* search is over (bye/thanks/not
  interested overall), not when they simply reject one specific property
  that was just shown. Rejecting a property prompts the agent to ask what
  didn't fit and offer alternatives instead of ending the conversation.
- **Never repeats an already-shown property**: each lead's Firestore document
  tracks `shownPropertyIds`, and the `search_properties` tool excludes those
  ids in code (not left to the model to remember), so the same listing can
  never be presented twice to the same lead.
- **BANT-style qualification, not just budget+bedrooms**: the agent also
  naturally gathers preferred location, timeline, and purpose (own use vs.
  investment) over the course of the conversation — all shown in the
  Insights table — while still being a genuinely useful conversational
  assistant that answers real questions rather than only running one script.
- **Two layers of idempotency** protect against duplicate replies: (1)
  `whatsappWebhook` atomically dedupes by WhatsApp `message.id` before ever
  enqueueing a Cloud Task, and (2) `processIncomingMessage` separately checks
  a `completed` flag on that same message id before doing any work — this
  covers Cloud Tasks' own at-least-once delivery guarantee, not just Meta's,
  so a message is processed exactly once end to end even under retries at
  either layer.
- **Property photos**: when the agent presents a specific listing, it returns
  that property's exact `id` (`matchedPropertyId`), and `processIncomingMessage`
  looks up that property's `imageUrl` in Firestore and sends it as a WhatsApp
  image message with a caption, right after the text reply.
- **Extracted data on every lead**: `extractedBudget`, `extractedBedrooms`,
  `propertyFound`, `conversationEnded`, and `lastMatchedPropertyId` are all
  written onto the lead's Firestore document as the conversation progresses
  (never overwritten with a blank value), and shown both as badges on the
  Leads pipeline and in full on the new **Insights** page — a flat, sortable
  table of every lead's extracted info in one place.
- **Human Agent Mode**: every lead has a `mode` field, `"ai"` (default,
  including any lead from before this shipped) or `"human"`. Toggle it from
  the AI/Human buttons in the chat header or the "AI replies automatically"
  switch in the customer panel — both just `updateDoc` the same field,
  straight from the browser, same as every other CRM edit. `processPhoneQueue`
  checks `lead.mode` right after syncing the incoming message into
  `conversationHistory`: in `"human"` mode it stops there — no LLM call, no
  WhatsApp send, no opportunity update — so incoming messages keep showing up
  live in the CRM while the AI stays silent. Sending a message manually (the
  composer at the bottom of the thread) hits the new `sendManualMessage`
  function, which sends via the WhatsApp Cloud API and appends the same turn
  shape the AI uses (`role`, `text`, `timestamp`), just tagged
  `sentBy: "human"` for the UI. Because it's the same `conversationHistory`
  array, switching back to `"ai"` mode means the very next incoming message
  is answered with full context — including everything the human agent
  said — with no extra merge step.
- `leadsWebhook` always returns HTTP 200 even on internal errors (logged via
  `firebase-functions/logger`) so Meta doesn't retry-storm the endpoint;
  check `firebase functions:log` when debugging.
