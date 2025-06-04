// ====================================
// SWIFTSEND PRO v3.1 - ENHANCED VERSION
// Complete rewrite with Google login, contacts import, and more
// ====================================

// Global configuration
const CONFIG = {
  APP_NAME: 'SwiftSend Pro v3',
  VERSION: '3.1',
  STORAGE_FOLDER: 'SwiftSend Pro Data',
  DB_FILE_NAME: 'swiftsend_database.json',
  TRACKING_ROUTE: 'track',
  MAX_BATCH_SIZE: 50,
  DEFAULT_RATE_LIMIT: 20,
  DEFAULT_CRM_FIELDS: [
    { id: 'firstName', name: 'First Name', type: 'text', required: false },
    { id: 'lastName', name: 'Last Name', type: 'text', required: false },
    { id: 'email', name: 'Email', type: 'email', required: true },
    { id: 'phone', name: 'Phone', type: 'phone', required: false },
    { id: 'company', name: 'Company', type: 'text', required: false },
    { id: 'position', name: 'Position', type: 'text', required: false },
    { id: 'office', name: 'Office', type: 'text', required: false },
    { id: 'notes', name: 'Notes', type: 'textarea', required: false }
  ]
};

// ====================================
// WEB APP ENTRY POINTS
// ====================================

function doGet(e) {
  try {
    // Handle tracking pixel requests
    if (e && e.parameter && e.parameter.action === CONFIG.TRACKING_ROUTE) {
      return handleTrackingPixel(e);
    }
    
    // Check if user is logged in
    const userEmail = Session.getActiveUser().getEmail();
    
    // Return login page if no user
    if (!userEmail) {
      return HtmlService.createTemplateFromFile('login')
        .evaluate()
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1')
        .setTitle(CONFIG.APP_NAME + ' - Login');
    }
    
    // Return main interface
    const template = HtmlService.createTemplateFromFile('index');
    template.config = CONFIG;
    template.userEmail = userEmail;
    
    return template.evaluate()
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setTitle(CONFIG.APP_NAME)
      .setFaviconUrl('https://cdn-icons-png.flaticon.com/512/732/732200.png');
  } catch (error) {
    return HtmlService.createHtmlOutput('Error: ' + error.toString());
  }
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ====================================
// AUTHENTICATION
// ====================================

function getAuthUrl() {
  const service = getOAuthService();
  return service.getAuthorizationUrl();
}

function getOAuthService() {
  return OAuth2.createService('Google')
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/auth')
    .setTokenUrl('https://accounts.google.com/o/oauth2/token')
    .setClientId(PropertiesService.getScriptProperties().getProperty('CLIENT_ID'))
    .setClientSecret(PropertiesService.getScriptProperties().getProperty('CLIENT_SECRET'))
    .setCallbackFunction('authCallback')
    .setPropertyStore(PropertiesService.getUserProperties())
    .setScope('https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/contacts.readonly')
    .setParam('access_type', 'offline')
    .setParam('approval_prompt', 'force');
}

function authCallback(request) {
  const service = getOAuthService();
  const authorized = service.handleCallback(request);
  if (authorized) {
    return HtmlService.createHtmlOutput('Success! You can close this tab.');
  } else {
    return HtmlService.createHtmlOutput('Denied. You can close this tab');
  }
}

// ====================================
// GOOGLE CONTACTS IMPORT
// ====================================

function importGoogleContacts() {
  try {
    const contacts = [];
    const pageToken = null;
    
    // Use People API to get contacts
    const response = People.People.Connections.list('people/me', {
      pageSize: 1000,
      personFields: 'names,emailAddresses,phoneNumbers,organizations,photos,addresses',
      pageToken: pageToken
    });
    
    if (response.connections) {
      response.connections.forEach(person => {
        const contact = {
          firstName: person.names?.[0]?.givenName || '',
          lastName: person.names?.[0]?.familyName || '',
          email: person.emailAddresses?.[0]?.value || '',
          phone: person.phoneNumbers?.[0]?.value || '',
          company: person.organizations?.[0]?.name || '',
          position: person.organizations?.[0]?.title || '',
          office: person.addresses?.[0]?.formattedValue || '',
          photoUrl: person.photos?.[0]?.url || '',
          googleContactId: person.resourceName
        };
        
        if (contact.email) {
          contacts.push(contact);
        }
      });
    }
    
    // Save contacts to database
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    let imported = 0;
    contacts.forEach(contact => {
      // Check if contact already exists
      const existing = currentUserDb.data.contacts.find(c => c.email === contact.email);
      if (!existing) {
        currentUserDb.addContact(contact);
        imported++;
      }
    });
    
    return { 
      success: true, 
      imported: imported,
      total: contacts.length
    };
    
  } catch (error) {
    console.error('Google Contacts import error:', error);
    return { success: false, error: error.message };
  }
}

// ====================================
// PROFILE PICTURE FETCHING
// ====================================

function getGmailProfilePicture(email) {
  try {
    // Try to get Google profile picture
    const response = UrlFetchApp.fetch(`https://www.google.com/s2/photos/profile/${email}`, {
      muteHttpExceptions: true,
      followRedirects: false
    });
    
    if (response.getResponseCode() === 200) {
      return Utilities.base64Encode(response.getBlob().getBytes());
    }
    
    // Try Gravatar as fallback
    const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, email.toLowerCase().trim())
      .map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'))
      .join('');
    
    const gravatarResponse = UrlFetchApp.fetch(`https://www.gravatar.com/avatar/${hash}?d=404`, {
      muteHttpExceptions: true
    });
    
    if (gravatarResponse.getResponseCode() === 200) {
      return Utilities.base64Encode(gravatarResponse.getBlob().getBytes());
    }
    
    return null;
  } catch (error) {
    console.error('Profile picture fetch error:', error);
    return null;
  }
}

// ====================================
// USER DATABASE MANAGEMENT (Enhanced)
// ====================================

class UserDatabase {
  constructor(userEmail) {
    this.userEmail = userEmail;
    this.folder = null;
    this.dbFile = null;
    this.data = this.getDefaultData();
  }
  
  getDefaultData() {
    return {
      version: CONFIG.VERSION,
      lastUpdated: new Date().toISOString(),
      profile: {
        email: this.userEmail,
        name: '',
        signature: '',
        photoUrl: '',
        settings: {
          notifications: true,
          darkMode: false,
          defaultFromName: '',
          defaultReplyTo: '',
          viewMode: 'grid' // grid or list
        }
      },
      crmSchema: {
        fields: CONFIG.DEFAULT_CRM_FIELDS,
        customFields: []
      },
      contacts: [],
      callLogs: [],
      emailTemplates: [],
      campaigns: [],
      analytics: {
        emailsSent: 0,
        emailsOpened: 0,
        linkClicks: 0,
        bounces: 0
      }
    };
  }
  
  init() {
    try {
      // Find or create storage folder
      const folders = DriveApp.getFoldersByName(CONFIG.STORAGE_FOLDER);
      if (folders.hasNext()) {
        this.folder = folders.next();
      } else {
        this.folder = DriveApp.createFolder(CONFIG.STORAGE_FOLDER);
      }
      
      // Find or create database file
      const files = this.folder.getFilesByName(CONFIG.DB_FILE_NAME);
      if (files.hasNext()) {
        this.dbFile = files.next();
        this.load();
      } else {
        this.dbFile = this.folder.createFile(CONFIG.DB_FILE_NAME, JSON.stringify(this.data, null, 2));
      }
      
      return true;
    } catch (error) {
      console.error('Database init error:', error);
      throw new Error('Failed to initialize database: ' + error.message);
    }
  }
  
  load() {
    try {
      const content = this.dbFile.getBlob().getDataAsString();
      const loadedData = JSON.parse(content);
      
      // Merge with default data to ensure all fields exist
      this.data = {
        ...this.getDefaultData(),
        ...loadedData,
        lastUpdated: new Date().toISOString()
      };
      
      // Ensure profile email matches current user
      this.data.profile.email = this.userEmail;
      
    } catch (error) {
      console.error('Database load error:', error);
      this.data = this.getDefaultData();
    }
  }
  
  save() {
    try {
      this.data.lastUpdated = new Date().toISOString();
      this.dbFile.setContent(JSON.stringify(this.data, null, 2));
      return true;
    } catch (error) {
      console.error('Database save error:', error);
      throw new Error('Failed to save database: ' + error.message);
    }
  }
  
  // Contact Management
  addContact(contact) {
    contact.id = Utilities.getUuid();
    contact.createdAt = new Date().toISOString();
    contact.updatedAt = new Date().toISOString();
    contact.selected = false;
    
    // Try to fetch profile picture if not provided
    if (!contact.photoUrl && contact.email) {
      const photo = getGmailProfilePicture(contact.email);
      if (photo) {
        contact.photoUrl = 'data:image/jpeg;base64,' + photo;
      }
    }
    
    this.data.contacts.push(contact);
    this.save();
    return contact;
  }
  
  updateContact(contactId, updates) {
    const index = this.data.contacts.findIndex(c => c.id === contactId);
    if (index >= 0) {
      this.data.contacts[index] = {
        ...this.data.contacts[index],
        ...updates,
        updatedAt: new Date().toISOString()
      };
      this.save();
      return this.data.contacts[index];
    }
    throw new Error('Contact not found');
  }
  
  deleteContact(contactId) {
    this.data.contacts = this.data.contacts.filter(c => c.id !== contactId);
    this.save();
  }
  
  toggleContactSelection(contactId) {
    const contact = this.data.contacts.find(c => c.id === contactId);
    if (contact) {
      contact.selected = !contact.selected;
      this.save();
      return contact;
    }
    return null;
  }
  
  // Call Log Management
  addCallLog(callLog) {
    callLog.id = Utilities.getUuid();
    callLog.timestamp = new Date().toISOString();
    this.data.callLogs.push(callLog);
    this.save();
    return callLog;
  }
  
  // CRM Schema Management
  updateCRMSchema(schema) {
    this.data.crmSchema = schema;
    this.save();
    return schema;
  }
  
  // Campaign Management
  addCampaign(campaign) {
    campaign.id = Utilities.getUuid();
    campaign.createdAt = new Date().toISOString();
    campaign.status = 'draft';
    this.data.campaigns.push(campaign);
    this.save();
    return campaign;
  }
  
  updateCampaignStatus(campaignId, status, stats = {}) {
    const campaign = this.data.campaigns.find(c => c.id === campaignId);
    if (campaign) {
      campaign.status = status;
      campaign.stats = { ...campaign.stats, ...stats };
      campaign.updatedAt = new Date().toISOString();
      this.save();
    }
  }
  
  // Analytics
  trackEmailSent() {
    this.data.analytics.emailsSent++;
    this.save();
  }
  
  trackEmailOpen(campaignId, contactId) {
    this.data.analytics.emailsOpened++;
    const campaign = this.data.campaigns.find(c => c.id === campaignId);
    if (campaign) {
      if (!campaign.opens) campaign.opens = {};
      campaign.opens[contactId] = (campaign.opens[contactId] || 0) + 1;
    }
    this.save();
  }
}

// ====================================
// USER SESSION MANAGEMENT
// ====================================

let currentUserDb = null;

function initializeUserSession() {
  try {
    const userEmail = Session.getActiveUser().getEmail();
    if (!userEmail) {
      throw new Error('Unable to identify user. Please ensure you are logged in to Google.');
    }
    
    currentUserDb = new UserDatabase(userEmail);
    currentUserDb.init();
    
    // Try to get user's Google profile picture
    const profilePic = getGmailProfilePicture(userEmail);
    if (profilePic && !currentUserDb.data.profile.photoUrl) {
      currentUserDb.data.profile.photoUrl = 'data:image/jpeg;base64,' + profilePic;
      currentUserDb.save();
    }
    
    return {
      success: true,
      userData: currentUserDb.data,
      quotaInfo: {
        remaining: MailApp.getRemainingDailyQuota(),
        isWorkspace: !userEmail.endsWith('@gmail.com')
      }
    };
  } catch (error) {
    console.error('Session initialization error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// ====================================
// API ENDPOINTS
// ====================================

// Profile Management
function updateProfile(profileData) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    currentUserDb.data.profile = {
      ...currentUserDb.data.profile,
      ...profileData
    };
    currentUserDb.save();
    
    return { success: true, profile: currentUserDb.data.profile };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// View Mode Toggle
function toggleViewMode() {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    const currentMode = currentUserDb.data.profile.settings.viewMode || 'grid';
    currentUserDb.data.profile.settings.viewMode = currentMode === 'grid' ? 'list' : 'grid';
    currentUserDb.save();
    
    return { success: true, viewMode: currentUserDb.data.profile.settings.viewMode };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// CRM Schema Management
function updateCRMFields(fields) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    currentUserDb.updateCRMSchema({ fields });
    return { success: true, schema: currentUserDb.data.crmSchema };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Contact Management
function getContacts() {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    return { 
      success: true, 
      contacts: currentUserDb.data.contacts,
      schema: currentUserDb.data.crmSchema,
      callLogsCount: currentUserDb.data.callLogs.length
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function saveContact(contactData) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    let contact;
    if (contactData.id) {
      contact = currentUserDb.updateContact(contactData.id, contactData);
    } else {
      contact = currentUserDb.addContact(contactData);
    }
    
    return { success: true, contact };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function deleteContact(contactId) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    currentUserDb.deleteContact(contactId);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function toggleContactSelection(contactId) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    const contact = currentUserDb.toggleContactSelection(contactId);
    return { success: true, contact };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function selectAllContacts(select) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    currentUserDb.data.contacts.forEach(contact => {
      contact.selected = select;
    });
    currentUserDb.save();
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Import contacts from Google Sheet
function importContactsFromSheet(sheetUrl, mapping) {
  try {
    const sheetId = extractSheetId(sheetUrl);
    const sheet = SpreadsheetApp.openById(sheetId).getActiveSheet();
    const data = sheet.getDataRange().getValues();
    
    if (data.length < 2) {
      throw new Error('Sheet must have headers and at least one data row');
    }
    
    const headers = data[0];
    const contacts = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const contact = {};
      
      Object.entries(mapping).forEach(([crmField, sheetColumn]) => {
        const colIndex = headers.indexOf(sheetColumn);
        if (colIndex >= 0) {
          contact[crmField] = row[colIndex] || '';
        }
      });
      
      if (contact.email && contact.email.includes('@')) {
        contacts.push(contact);
      }
    }
    
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    contacts.forEach(contact => currentUserDb.addContact(contact));
    
    return { 
      success: true, 
      imported: contacts.length,
      total: data.length - 1
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Call Logging
function logCall(callData) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    const callLog = currentUserDb.addCallLog(callData);
    
    if (callData.contactId) {
      const contact = currentUserDb.data.contacts.find(c => c.id === callData.contactId);
      if (contact) {
        contact.lastCallDate = callLog.timestamp;
        contact.lastCallOutcome = callData.outcome;
        contact.nextCallDate = callData.nextCallDate;
        currentUserDb.save();
      }
    }
    
    return { success: true, callLog, totalCallLogs: currentUserDb.data.callLogs.length };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getCallLogs(contactId = null) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    let logs = currentUserDb.data.callLogs;
    if (contactId) {
      logs = logs.filter(log => log.contactId === contactId);
    }
    
    return { success: true, callLogs: logs };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Email Templates
function saveEmailTemplate(template) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    if (!template.id) {
      template.id = Utilities.getUuid();
      template.createdAt = new Date().toISOString();
      currentUserDb.data.emailTemplates.push(template);
    } else {
      const index = currentUserDb.data.emailTemplates.findIndex(t => t.id === template.id);
      if (index >= 0) {
        currentUserDb.data.emailTemplates[index] = {
          ...template,
          updatedAt: new Date().toISOString()
        };
      }
    }
    
    currentUserDb.save();
    return { success: true, template };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getEmailTemplates() {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    return { success: true, templates: currentUserDb.data.emailTemplates };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Mass Email Sending (Enhanced with HTML support)
function sendMassEmails(campaignData) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    const campaign = currentUserDb.addCampaign(campaignData);
    const results = [];
    let successCount = 0;
    let errorCount = 0;
    
    // Get selected recipients
    const recipients = campaignData.selectedOnly ? 
      currentUserDb.data.contacts.filter(c => c.selected) : 
      campaignData.recipients;
    
    for (const recipient of recipients) {
      try {
        if (MailApp.getRemainingDailyQuota() <= 0) {
          throw new Error('Daily email quota exceeded');
        }
        
        const subject = replaceMergeTags(campaignData.subject, recipient);
        let htmlBody = replaceMergeTags(campaignData.htmlBody, recipient);
        
        // Ensure HTML is properly formatted
        if (!htmlBody.includes('<html>')) {
          htmlBody = `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
              </style>
            </head>
            <body>
              <div class="container">
                ${htmlBody}
              </div>
            </body>
            </html>
          `;
        }
        
        const trackingId = Utilities.getUuid();
        const trackingUrl = getTrackingUrl(campaign.id, recipient.id || recipient.email, trackingId);
        htmlBody = htmlBody.replace('</body>', `<img src="${trackingUrl}" width="1" height="1" style="display:none;" alt=""></body>`);
        
        MailApp.sendEmail({
          to: recipient.email,
          subject: subject,
          htmlBody: htmlBody,
          name: campaignData.fromName || currentUserDb.data.profile.name,
          replyTo: campaignData.replyTo || currentUserDb.data.profile.email
        });
        
        successCount++;
        currentUserDb.trackEmailSent();
        
        results.push({
          recipient: recipient.email,
          status: 'sent',
          trackingId: trackingId
        });
        
        Utilities.sleep(Math.floor(60000 / (campaignData.rateLimit || CONFIG.DEFAULT_RATE_LIMIT)));
        
      } catch (error) {
        errorCount++;
        results.push({
          recipient: recipient.email,
          status: 'error',
          error: error.message
        });
      }
    }
    
    currentUserDb.updateCampaignStatus(campaign.id, 'completed', {
      sent: successCount,
      errors: errorCount,
      completedAt: new Date().toISOString()
    });
    
    return {
      success: true,
      campaignId: campaign.id,
      results: results,
      summary: {
        total: recipients.length,
        sent: successCount,
        errors: errorCount
      }
    };
    
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Send test email
function sendTestEmail(emailData) {
  try {
    const subject = replaceMergeTags(emailData.subject, emailData.testData || {});
    let htmlBody = replaceMergeTags(emailData.htmlBody, emailData.testData || {});
    
    // Ensure HTML is properly formatted
    if (!htmlBody.includes('<html>')) {
      htmlBody = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            ${htmlBody}
          </div>
        </body>
        </html>
      `;
    }
    
    MailApp.sendEmail({
      to: emailData.testEmail,
      subject: subject,
      htmlBody: htmlBody,
      name: emailData.fromName || Session.getActiveUser().getEmail(),
      replyTo: emailData.replyTo || Session.getActiveUser().getEmail()
    });
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Analytics & Tracking
function handleTrackingPixel(e) {
  try {
    const campaignId = e.parameter.cid;
    const contactId = e.parameter.rid;
    const trackingId = e.parameter.tid;
    
    if (campaignId && contactId) {
      if (!currentUserDb) {
        // Try to identify user from tracking data
        const userEmail = e.parameter.u;
        if (userEmail) {
          currentUserDb = new UserDatabase(userEmail);
          currentUserDb.init();
          currentUserDb.trackEmailOpen(campaignId, contactId);
        }
      }
    }
    
    return ContentService
      .createTextOutput(Utilities.base64Decode('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'))
      .setMimeType(ContentService.MimeType.GIF);
      
  } catch (error) {
    console.error('Tracking error:', error);
    return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
  }
}

function getTrackingUrl(campaignId, recipientId, trackingId) {
  const scriptUrl = ScriptApp.getService().getUrl();
  const userEmail = Session.getActiveUser().getEmail();
  return `${scriptUrl}?action=${CONFIG.TRACKING_ROUTE}&cid=${campaignId}&rid=${recipientId}&tid=${trackingId}&u=${encodeURIComponent(userEmail)}`;
}

function getCampaignAnalytics(campaignId = null) {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    if (campaignId) {
      const campaign = currentUserDb.data.campaigns.find(c => c.id === campaignId);
      return { success: true, campaign };
    } else {
      return { 
        success: true, 
        campaigns: currentUserDb.data.campaigns,
        overall: currentUserDb.data.analytics 
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Utility Functions
function extractSheetId(sheetUrl) {
  if (sheetUrl.includes('docs.google.com')) {
    const match = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!match) throw new Error('Invalid Google Sheets URL');
    return match[1];
  }
  return sheetUrl;
}

function replaceMergeTags(text, data) {
  let result = text;
  Object.entries(data).forEach(([key, value]) => {
    const tag = new RegExp(`{{\\s*${key}\\s*}}`, 'gi');
    result = result.replace(tag, value || '');
  });
  // Also replace special tags
  result = result.replace(/{{fromName}}/gi, currentUserDb?.data.profile.name || '');
  return result;
}

// Export data
function exportUserData() {
  try {
    if (!currentUserDb) currentUserDb = new UserDatabase(Session.getActiveUser().getEmail());
    currentUserDb.init();
    
    const blob = Utilities.newBlob(
      JSON.stringify(currentUserDb.data, null, 2),
      'application/json',
      `swiftsend_export_${new Date().toISOString()}.json`
    );
    
    return {
      success: true,
      downloadUrl: DriveApp.createFile(blob).getDownloadUrl()
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Test function
function testSetup() {
  console.log('Testing SwiftSend Pro v3.1...');
  
  // Test if People API is enabled
  try {
    const people = People.People.get('people/me', {personFields: 'names'});
    console.log('People API: Enabled');
  } catch (e) {
    console.log('People API: Not enabled - Enable it in Services');
  }
  
  const result = initializeUserSession();
  console.log('Session Init:', result);
  
  if (result.success) {
    console.log('User Data:', result.userData);
    console.log('Quota Info:', result.quotaInfo);
  }
  
  return 'Test complete! Check logs for details.';
}
