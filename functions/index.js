const admin = require("firebase-admin");

admin.initializeApp();

const { leadsWebhook } = require("./src/leadsWebhook");
const { followupCheck } = require("./src/followupCheck");
const { whatsappWebhook } = require("./src/whatsappWebhook");

exports.leadsWebhook = leadsWebhook;
exports.followupCheck = followupCheck;
exports.whatsappWebhook = whatsappWebhook;
