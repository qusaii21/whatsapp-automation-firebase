const admin = require("firebase-admin");

admin.initializeApp();

const { leadsWebhook } = require("./src/leadsWebhook");
const { followupCheck } = require("./src/followupCheck");
const { whatsappWebhook } = require("./src/whatsappWebhook");
const { processPhoneQueue } = require("./src/processPhoneQueue");
const { sendManualMessage } = require("./src/sendManualMessage");

exports.leadsWebhook = leadsWebhook;
exports.followupCheck = followupCheck;
exports.whatsappWebhook = whatsappWebhook;
exports.processPhoneQueue = processPhoneQueue;
exports.sendManualMessage = sendManualMessage;
