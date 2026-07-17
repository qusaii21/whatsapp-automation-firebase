const admin = require("firebase-admin");

admin.initializeApp();

const { leadsWebhook } = require("./src/leadsWebhook");
const { followupCheck } = require("./src/followupCheck");
const { whatsappWebhook } = require("./src/whatsappWebhook");
const { processPhoneQueue } = require("./src/processPhoneQueue");
const { sendManualMessage } = require("./src/sendManualMessage");
const { createCampaign } = require("./src/createCampaign");
const { addCampaignRecipients } = require("./src/addCampaignRecipients");
const { launchCampaign } = require("./src/launchCampaign");
const { dispatchCampaignQueue } = require("./src/dispatchCampaignQueue");
const { processCampaignRecipient } = require("./src/processCampaignRecipient");
const { pauseCampaign, resumeCampaign, cancelCampaign, retryCampaignDispatch } = require("./src/campaignControl");
const { duplicateCampaign } = require("./src/duplicateCampaign");
const { syncTemplates } = require("./src/syncTemplates");
const { createTemplate } = require("./src/createTemplate");
const { fetchTemplateDetails } = require("./src/fetchTemplateDetails");
const { refreshTemplate } = require("./src/refreshTemplate");
const { createAgency } = require("./src/createAgency");
const { inviteMember } = require("./src/inviteMember");
const { acceptInvite } = require("./src/acceptInvite");
const {
  connectWhatsApp,
  getIntegrationStatus,
  disconnectWhatsApp,
  checkWhatsAppHealth,
} = require("./src/whatsappIntegration");
const {
  connectFacebook,
  getFacebookIntegrationStatus,
  disconnectFacebook,
  checkFacebookHealth,
} = require("./src/facebookIntegration");

exports.leadsWebhook = leadsWebhook;
exports.followupCheck = followupCheck;
exports.whatsappWebhook = whatsappWebhook;
exports.processPhoneQueue = processPhoneQueue;
exports.sendManualMessage = sendManualMessage;
exports.createCampaign = createCampaign;
exports.addCampaignRecipients = addCampaignRecipients;
exports.launchCampaign = launchCampaign;
exports.dispatchCampaignQueue = dispatchCampaignQueue;
exports.processCampaignRecipient = processCampaignRecipient;
exports.pauseCampaign = pauseCampaign;
exports.resumeCampaign = resumeCampaign;
exports.cancelCampaign = cancelCampaign;
exports.retryCampaignDispatch = retryCampaignDispatch;
exports.duplicateCampaign = duplicateCampaign;
exports.syncTemplates = syncTemplates;
exports.createTemplate = createTemplate;
exports.fetchTemplateDetails = fetchTemplateDetails;
exports.refreshTemplate = refreshTemplate;
exports.createAgency = createAgency;
exports.inviteMember = inviteMember;
exports.acceptInvite = acceptInvite;
exports.connectWhatsApp = connectWhatsApp;
exports.getIntegrationStatus = getIntegrationStatus;
exports.disconnectWhatsApp = disconnectWhatsApp;
exports.checkWhatsAppHealth = checkWhatsAppHealth;
exports.connectFacebook = connectFacebook;
exports.getFacebookIntegrationStatus = getFacebookIntegrationStatus;
exports.disconnectFacebook = disconnectFacebook;
exports.checkFacebookHealth = checkFacebookHealth;
