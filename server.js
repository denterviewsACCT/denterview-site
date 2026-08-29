// server.js - Denterview AI Backend Server - PRODUCTION VERSION WITH RESEND EMAIL
// Uses Resend API for reliable email delivery (no SMTP blocking issues)

import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { readFileSync } from 'fs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

// SECURITY: Environment variables
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Denterview AI <onboarding@resend.dev>';
const PAYHIP_API_KEY = process.env.PAYHIP_API_KEY;
const GOOGLE_ADS_CONVERSION_ID = process.env.GOOGLE_ADS_CONVERSION_ID || 'AW-17341313917';
const GOOGLE_ADS_CONVERSION_LABEL = process.env.GOOGLE_ADS_CONVERSION_LABEL || 'REPLACE_WITH_YOUR_LABEL';

// Validate critical environment variables
if (!GOOGLE_API_KEY) {
  console.error('❌ CRITICAL: GOOGLE_API_KEY not set');
  process.exit(1);
}

// Initialize Firebase Admin
let adminDb;
let adminAuth;
try {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
  
  let serviceAccount;
  try {
    const keyFile = readFileSync('./firebase-admin-key.json', 'utf8');
    serviceAccount = JSON.parse(keyFile);
    console.log('✅ Loaded Firebase key from file');
  } catch (fileError) {
    if (process.env.FIREBASE_ADMIN_KEY) {
      serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
      console.log('✅ Loaded Firebase key from environment variable');
    } else {
      throw new Error('No Firebase key found');
    }
  }
  
  initializeApp({
    credential: cert(serviceAccount)
  });
  adminDb = getFirestore();
  adminAuth = getAuth();
  console.log('✅ Firebase Admin initialized');
} catch (error) {
  console.error('❌ Firebase Admin initialization failed:', error.message);
  process.exit(1);
}

// Email service setup - Using Resend (HTTP API, no SMTP blocking issues)
async function sendEmail(to, subject, html, text) {
  if (!RESEND_API_KEY) {
    console.warn('⚠️  RESEND_API_KEY not configured - skipping email');
    return { success: false, error: 'Email service not configured' };
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [to],
        subject: subject,
        html: html,
        text: text
      })
    });

    const data = await response.json();

    if (response.ok) {
      console.log(`📧 Email sent to ${to} (ID: ${data.id})`);
      return { success: true, id: data.id };
    } else {
      console.error('❌ Resend API error:', data);
      return { success: false, error: data.message };
    }
  } catch (error) {
    console.error('❌ Email send failed:', error.message);
    return { success: false, error: error.message };
  }
}

console.log('✅ Email service configured (Resend API)');

// SECURITY: Middleware
app.use(cors({ 
  origin: IS_PRODUCTION ? process.env.ALLOWED_ORIGINS?.split(',') : true,
  credentials: true
}));

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// SECURITY: Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// SECURITY: Rate limiting
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 100;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const limit = rateLimits.get(ip);
  
  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + RATE_LIMIT_WINDOW;
    return next();
  }
  
  if (limit.count >= RATE_LIMIT_MAX) {
    return res.status(429).json({ 
      success: false, 
      message: 'Too many requests. Please try again later.' 
    });
  }
  
  limit.count++;
  next();
}

app.use('/api/', rateLimit);

// Helper functions
function base64ToPart(base64Data, mimeType) {
  return {
    inlineData: {
      data: base64Data,
      mimeType: mimeType,
    },
  };
}

function generateUserId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const segments = [4, 4, 4, 4];
  
  return segments.map(length => {
    return Array(length).fill(0).map(() => 
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  }).join('-');
}

// Used only by /api/create-user for manual provisioning.
// Webhook logic uses the INTERVIEW_PRODUCTS table inside the webhook handler.
function getInterviewCountForProduct(productId) {
  const productMap = {
    'starter-pack': 2,
    'confidence-pack': 3,
    'mastery-pack': 5,
    'expert-pack': 8,
    'acceptance-pack': 12,
    'interview-bundle': 3,   // $25.99 bundle (guide + 3 AI sessions)
    'complete-bundle': 3,    // $60.99 bundle (PS + guide + 3 AI sessions)
    '2-pack': 2,
    '3-pack': 3,
    '5-pack': 5,
    '8-pack': 8,
    '12-pack': 12,
    'single-interview': 1
  };
  
  return productMap[productId?.toLowerCase()] || 1;
}

async function createFirebaseUser(email, password, interviewCount) {
  if (!adminDb || !adminAuth) {
    throw new Error('Firebase Admin not initialized');
  }

  try {
    const userRecord = await adminAuth.createUser({
      email: email,
      password: password,
      emailVerified: false
    });

    console.log(`✅ Created Firebase Auth user: ${userRecord.uid}`);

    const userRef = adminDb.collection('artifacts')
      .doc('default-app-id')
      .collection('public')
      .doc('data')
      .collection('users')
      .doc(userRecord.uid);
    
    await userRef.set({
      email: email,
      totalInterviews: interviewCount,
      interviewsRemaining: interviewCount,
      completedPools: [],
      currentPoolId: null,
      interviewHistory: [],
      createdAt: new Date().toISOString(),
      lastLogin: null,
      lastPurchaseDate: new Date().toISOString()
    });

    console.log(`✅ Created Firestore user: ${userRecord.uid} with ${interviewCount} interviews`);
    return { userId: userRecord.uid, isNewUser: true };
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      const userRecord = await adminAuth.getUserByEmail(email);
      const userRef = adminDb.collection('artifacts')
        .doc('default-app-id')
        .collection('public')
        .doc('data')
        .collection('users')
        .doc(userRecord.uid);
      
      const userDoc = await userRef.get();
      
      if (!userDoc.exists) {
        await userRef.set({
          email: email,
          totalInterviews: interviewCount,
          interviewsRemaining: interviewCount,
          completedPools: [],
          currentPoolId: null,
          interviewHistory: [],
          createdAt: new Date().toISOString(),
          lastLogin: null,
          lastPurchaseDate: new Date().toISOString()
        });
        
        console.log(`✅ Re-created Firestore user data for Auth user: ${userRecord.uid} - Added ${interviewCount} interviews`);
        return { userId: userRecord.uid, isNewUser: true };
      } else {
        const currentData = userDoc.data();
        const newTotal = (currentData.totalInterviews || 0) + interviewCount;
        const newRemaining = (currentData.interviewsRemaining || 0) + interviewCount;
        
        await userRef.update({
          totalInterviews: newTotal,
          interviewsRemaining: newRemaining,
          lastPurchaseDate: new Date().toISOString()
        });
        
        console.log(`✅ Updated existing user: ${userRecord.uid} - Added ${interviewCount} interviews`);
        return { userId: userRecord.uid, isNewUser: false };
      }
    }
    throw error;
  }
}

async function sendWelcomeEmail(email, password, interviewCount, isReturning = false) {
  const subject = isReturning ? 
    '🦷 Denterview AI - Interviews Added!' :
    '🦷 Welcome to Denterview AI';

  const welcomeMessage = isReturning ?
    `<p style="font-size: 16px; color: #374151;">Thank you for your continued trust! We've added <strong>${interviewCount} interview ${interviewCount === 1 ? 'session' : 'sessions'}</strong> to your account.</p>` :
    `<p style="font-size: 16px; color: #374151;">Thank you for your purchase! You now have access to <strong>${interviewCount} mock interview ${interviewCount === 1 ? 'session' : 'sessions'}</strong>.</p>`;

  const credentialsSection = !isReturning ? `
    <div style="background: white; padding: 20px; border-radius: 8px; border: 2px solid #667eea; margin: 20px 0;">
      <p style="color: #6b7280; margin: 0 0 10px 0; font-size: 14px;">Your Login Credentials:</p>
      <p style="font-size: 16px; color: #374151; margin: 5px 0;"><strong>Email:</strong> ${email}</p>
      <p style="font-size: 16px; color: #374151; margin: 5px 0;"><strong>Password:</strong> <code style="background: #f3f4f6; padding: 4px 8px; border-radius: 4px; font-family: monospace;">${password}</code></p>
      <p style="color: #ef4444; font-size: 13px; margin-top: 10px;">⚠️ <strong>Important:</strong> Please save these credentials and change your password after logging in.</p>
      
      <div style="margin-top: 25px; padding: 20px; background: #f0f4ff; border-radius: 8px; text-align: center;">
        <p style="font-size: 16px; color: #374151; margin: 0;">
          Please go to <a href="https://www.denterviewai.com" style="color: #667eea; font-weight: bold; text-decoration: none;">denterviewai.com</a> to start your interview now!
        </p>
      </div>
    </div>
  ` : '';

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
        <h1 style="color: white; margin: 0;">${isReturning ? 'Welcome Back!' : 'Welcome to Denterview AI!'} 🎉</h1>
      </div>
      
      <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 10px 10px;">
        ${welcomeMessage}
        
        ${credentialsSection}
        
        <h3 style="color: #374151; margin-top: 30px;">${isReturning ? 'Ready to Continue?' : "What's Next?"}</h3>
        <ol style="color: #6b7280; line-height: 1.8;">
          <li>Go to your Denterview AI app</li>
          <li>Sign in with your email${!isReturning ? ' and password' : ''}</li>
          ${!isReturning ? '<li>Allow camera and microphone access</li>' : '<li>Check your updated interview balance</li>'}
          <li>Start practicing!</li>
        </ol>
        
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
        
        <p style="color: #9ca3af; font-size: 12px; text-align: center;">
          Questions? Reply to this email for support<br>
          ${!isReturning ? 'This is an automated email. Please save your login credentials.' : 'Thank you for being a valued customer!'}
        </p>
      </div>
    </div>
  `;

  const textContent = `
${isReturning ? 'Welcome Back!' : 'Welcome to Denterview AI!'}

${isReturning ? `We've added ${interviewCount} interview ${interviewCount === 1 ? 'session' : 'sessions'} to your account.` : `You now have ${interviewCount} interview ${interviewCount === 1 ? 'session' : 'sessions'}.`}

${!isReturning ? `
Login Credentials:
Email: ${email}
Password: ${password}

⚠️ IMPORTANT: Save these credentials and change your password after logging in.
` : ''}

What's Next:
1. Go to your Denterview AI app
2. Sign in with your email${!isReturning ? ' and password' : ''}
3. ${!isReturning ? 'Allow camera and microphone access' : 'Check your updated interview balance'}
4. Start practicing!

Questions? Reply to this email for support.
  `;

  const result = await sendEmail(email, subject, htmlContent, textContent);
  
  if (!result.success) {
    console.error(`❌ Failed to send email to ${email}:`, result.error);
  }
}

// Google Ads Measurement Protocol conversion hit
async function sendGoogleAdsConversion(value, currency, transactionId) {
  try {
    const conversionLabel = GOOGLE_ADS_CONVERSION_LABEL;
    if (conversionLabel === 'REPLACE_WITH_YOUR_LABEL') {
      console.warn('⚠️  Google Ads conversion label not set - skipping conversion hit');
      return;
    }

    const params = new URLSearchParams({
      v: '2',
      t: 'event',
      tid: GOOGLE_ADS_CONVERSION_ID,
      en: 'conversion',
      'epn.value': value.toString(),
      'epn.currency': currency,
      'epn.transaction_id': transactionId,
      'aw_merchant_id': GOOGLE_ADS_CONVERSION_ID,
      'aw_feed_country': 'US',
      'aw_feed_language': 'EN',
    });

    const url = `https://www.google-analytics.com/g/collect`;

    const response = await fetch(`${url}?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (response.ok) {
      console.log(`📊 Google Ads conversion fired (txn: ${transactionId}, value: ${value} ${currency})`);
    } else {
      console.warn(`⚠️  Google Ads conversion hit returned ${response.status}`);
    }
  } catch (error) {
    console.warn('⚠️  Google Ads conversion hit failed (non-blocking):', error.message);
  }
}

// SECURITY: Webhook verification
function verifyPayhipWebhook(req) {
  if (!PAYHIP_API_KEY) {
    console.error('❌ PAYHIP_API_KEY not configured');
    return false;
  }

  const signature = req.body.signature;
  if (!signature) {
    console.error('❌ No signature in webhook');
    return false;
  }

  const hash = crypto.createHash('sha256')
    .update(PAYHIP_API_KEY)
    .digest('hex');
  
  if (signature !== hash) {
    console.error('❌ INVALID WEBHOOK SIGNATURE - Possible attack!');
    return false;
  }
  
  console.log('✅ Webhook signature verified');
  return true;
}

// SECURITY: Input sanitization
function sanitizeEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email)) {
    throw new Error('Invalid email format');
  }
  return email.toLowerCase().trim();
}

// Root route
app.get('/', (req, res) => {
    res.sendFile('index.html', { root: '.' }); 
});

// AI Analysis endpoint
app.post('/api/analyze', async (req, res) => {
  try {
    const { systemInstruction, userPrompt, imageBase64, videoBase64, videoMimeType } = req.body;

    if (!userPrompt || !systemInstruction) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required data' 
      });
    }

    if (videoBase64 && videoBase64.length > 100 * 1024 * 1024) {
      return res.status(413).json({ 
        success: false, 
        message: 'Video data too large' 
      });
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_API_KEY}`;
    
    const contents = [{ text: userPrompt }];

    if (videoBase64) {
      // Trust the client's reported mimeType only if it's one we actually
      // support recording in (index.html's codec fallback chain). Anything
      // else — missing, malformed, or unexpected — falls back to webm.
      // Hardcoding 'video/webm' here regardless of the real container was
      // the root cause of Gemini's "0 Frames found" / blockReason:OTHER
      // failures on Safari/iOS, which record mp4 instead of webm.
      // Browsers can report codec params in mimeType (e.g. Safari:
      // video/mp4;codecs="avc1.42E01E, mp4a.40.2"). Gemini's inlineData
      // expects a plain type, and an exact-string allowlist would miss
      // these variants and silently fall back to webm — reproducing the
      // original bug for exactly the browsers it's meant to fix. Strip
      // params and match on the base type instead.
      const baseMimeType = typeof videoMimeType === 'string' ? videoMimeType.split(';')[0].trim().toLowerCase() : '';
      const ALLOWED_VIDEO_MIME_TYPES = new Set(['video/webm', 'video/mp4']);
      const resolvedMimeType = ALLOWED_VIDEO_MIME_TYPES.has(baseMimeType) ? baseMimeType : 'video/webm';
      contents.push(base64ToPart(videoBase64, resolvedMimeType));
    }

    if (imageBase64) {
      contents.push(base64ToPart(imageBase64, 'image/jpeg'));
    }

    const payload = {
      contents: [{ role: 'user', parts: contents }],
      systemInstruction: { parts: [{ text: systemInstruction }] }
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 240 * 1000); // 4 min

    let gResp;
    try {
      gResp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (fetchErr) {
      if (fetchErr.name === 'AbortError') {
        console.error('❌ Gemini request timed out after 4 min');
        return res.status(504).json({ success: false, message: 'Analysis timed out' });
      }
      throw fetchErr;
    } finally {
      clearTimeout(timeoutId);
    }

    const gBody = await gResp.text();

    if (!gResp.ok) {
      let parsed;
      try { 
        parsed = JSON.parse(gBody); 
      } catch (e) { 
        parsed = { text: gBody }; 
      }
      
      const errorMessage = IS_PRODUCTION ? 
        'Analysis service temporarily unavailable' : 
        `Upstream error: ${parsed.message || gResp.statusText}`;
      
      console.error('❌ Gemini API Error:', parsed);
      return res.status(502).json({ 
        success: false, 
        message: errorMessage
      });
    }

    let parsedResp;
    try {
      parsedResp = JSON.parse(gBody);
    } catch (e) {
      parsedResp = { 
        candidates: [{ 
          content: { 
            parts: [{ text: gBody || "Analysis failed." }]
          } 
        }]
      };
    }

    const returnedText = parsedResp?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!returnedText) {
      console.error('⚠️  Gemini returned 200 but no usable text. blockReason:',
        parsedResp?.promptFeedback?.blockReason,
        '| finishReason:', parsedResp?.candidates?.[0]?.finishReason,
        '| safetyRatings:', JSON.stringify(parsedResp?.candidates?.[0]?.safetyRatings || parsedResp?.promptFeedback?.safetyRatings),
        '| raw:', JSON.stringify(parsedResp).slice(0, 1000)
      );
    }

    return res.json({ success: true, data: parsedResp });

  } catch (err) {
    console.error('❌ Server error during analysis:', err);
    
    const errorMessage = IS_PRODUCTION ? 
      'Internal server error' : 
      err.message;
    
    return res.status(500).json({ 
      success: false, 
      message: errorMessage
    });
  }
});

// Email sending endpoint
app.post('/api/send-email', async (req, res) => {
  try {
    const { email, content } = req.body;

    if (!email || !content) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing email or content' 
      });
    }

    const sanitizedEmail = sanitizeEmail(email);

    if (content.length > 500000) {
      return res.status(413).json({ 
        success: false, 
        message: 'Content too large' 
      });
    }

    const htmlContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #667eea;">Your Denterview Interview Results</h2>
        <p>Thank you for completing your mock interview. Here are your detailed results:</p>
        <div style="white-space: pre-wrap; background: #f5f5f5; padding: 20px; border-radius: 8px;">
          ${content.replace(/\n/g, '<br>')}
        </div>
      </div>
    `;

    const result = await sendEmail(
      sanitizedEmail,
      'Your Denterview Interview Results',
      htmlContent,
      content
    );

    if (result.success) {
      res.json({ 
        success: true, 
        message: 'Email sent successfully',
        messageId: result.id 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to send email',
        error: result.error 
      });
    }

  } catch (err) {
    console.error('❌ Email error:', err.message);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to send email' 
    });
  }
});

// Payhip Webhook endpoint - FIXED VERSION with strict product filtering
app.post('/api/payhip-webhook', async (req, res) => {
  try {
    console.log('📥 Received Payhip webhook');

    if (!verifyPayhipWebhook(req)) {
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid signature' 
      });
    }

    // Respond 200 immediately so Payhip doesn't time out waiting
    res.status(200).json({ success: true, message: 'Webhook received' });

    const { type, email, currency, price, items } = req.body;

    console.log(`📢 Type: ${type}, Email: ${email}, Amount: ${price} ${currency}`);

    if (type !== 'paid') {
      console.log('⏭️  Skipping non-paid event');
      return;
    }

    if (!email || !items || items.length === 0) {
      console.error('❌ Invalid webhook data');
      return;
    }

    const sanitizedEmail = sanitizeEmail(email);

    const product = items[0];
    const productName = product.product_name;
    const productId = product.product_id;
    
    console.log(`📦 Product: "${productName}" (ID: ${productId})`);

    const productNameLower = productName.toLowerCase().trim();

    // ── PRODUCT LOOKUP TABLE ──────────────────────────────────────────────────
    // Maps keyword fragments (matched against product name) to interview counts.
    // Bundles that include AI mock interviews are listed alongside standalone packs.
    // ADD new products here — no other code needs to change.
    //
    // Key = substring that uniquely identifies the Payhip product name (lowercase)
    // Value = { interviews: N, label: 'Human readable name for logs' }
    //
    // Standalone AI packs
    const INTERVIEW_PRODUCTS = [
      { match: 'starter',           interviews: 2,  label: 'Starter Pack (2)' },
      { match: 'confidence',        interviews: 3,  label: 'Confidence Pack (3)' },
      { match: 'mastery',           interviews: 5,  label: 'Mastery Pack (5)' },
      { match: 'expert',            interviews: 8,  label: 'Expert Pack (8)' },
      { match: 'acceptance',        interviews: 12, label: 'Acceptance Pack (12)' },
      // Bundles that include AI mock interviews
      // "$25.99 bundle" = Ultimate Guide + 3 AI sessions
      { match: 'ultimate interview prep bundle', interviews: 3, label: 'Ultimate Interview Prep Bundle (3)' },
      // "$60.99 bundle" = Complete Dental School Prep Bundle (PS review + guide + AI)
      // Adjust the interview count below if Payhip product name or session count changes
      { match: 'complete dental school prep bundle', interviews: 3, label: 'Complete Dental School Prep Bundle (3)' },
    ];

    // Products that contain AI interviews but whose name we don't recognise yet
    // will fall through to the UNKNOWN block below and get logged — never silently dropped.
    const SKIP_KEYWORDS = [
      'essential dental school',  // catches all 3 Essential PDF variants
      'essential questions',
      'questions and approach',
      'full package',        // Ultimate Guide standalone PDF
      'personal statement',
      'ps review',
      'second round',        // second round edits (PS product)
      'rush 24',             // personal statement rush 24 hour edit
    ];

    // Check if this is a known guide-only / non-interview product to skip cleanly
    const isGuideOnly = SKIP_KEYWORDS.some(kw => productNameLower.includes(kw));
    if (isGuideOnly) {
      console.log(`⏭️  Skipping guide/PS product (no AI interviews): "${productName}"`);
      return;
    }

    // Find the matching interview product
    const matched = INTERVIEW_PRODUCTS.find(p => productNameLower.includes(p.match));

    let interviewCount;
    if (matched) {
      interviewCount = matched.interviews;
      console.log(`✅ Identified as ${matched.label}`);
    } else {
      // UNKNOWN product — log loudly so you can add it to the table above.
      // Still creates the user with 1 interview rather than silently doing nothing.
      interviewCount = 1;
      console.error(`⚠️  UNKNOWN PRODUCT — could not identify interview count for: "${productName}"`);
      console.error(`⚠️  Add this product to INTERVIEW_PRODUCTS or SKIP_KEYWORDS in server.js`);
      console.error(`⚠️  Defaulting to 1 interview — please manually correct if needed`);
    }
    
    console.log(`🎫 Interviews to add: ${interviewCount}`);
    
    const randomPassword = generateUserId().substring(0, 12);
    
    const result = await createFirebaseUser(sanitizedEmail, randomPassword, interviewCount);
    
    console.log(result.isNewUser ? `✨ New customer: ${sanitizedEmail}` : `🔄 Returning customer: ${sanitizedEmail}`);

    // Fire Google Ads conversion (non-blocking)
    const transactionId = `payhip-${Date.now()}-${result.userId}`;
    const purchaseValue = parseFloat(price) || 25.0;
    const purchaseCurrency = (currency || 'USD').toUpperCase();
    await sendGoogleAdsConversion(purchaseValue, purchaseCurrency, transactionId);

    await sendWelcomeEmail(sanitizedEmail, randomPassword, interviewCount, !result.isNewUser);
    
    console.log(`✅ Successfully processed mock interview purchase`);
    
    console.log('✅ Webhook processing complete');

  } catch (err) {
    console.error('❌ Webhook error:', err);
    // Response already sent, just log the error
  }
});
// Manual user creation endpoint
app.post('/api/create-user', async (req, res) => {
  try {
    const { email, password, interviewCount } = req.body;

    if (!email || !password || !interviewCount) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing email, password, or interviewCount' 
      });
    }

    const sanitizedEmail = sanitizeEmail(email);

    if (interviewCount < 1 || interviewCount > 100) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid interview count (must be 1-100)' 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        success: false, 
        message: 'Password must be at least 6 characters' 
      });
    }

    const result = await createFirebaseUser(sanitizedEmail, password, interviewCount);
    
    await sendWelcomeEmail(sanitizedEmail, password, interviewCount, !result.isNewUser);
    
    console.log(`✅ Manually ${result.isNewUser ? 'created' : 'updated'} user: ${result.userId}`);
    
    res.json({ 
      success: true, 
      userId: result.userId,
      email: sanitizedEmail,
      interviewCount: interviewCount,
      isReturning: !result.isNewUser,
      message: result.isNewUser ? 'User created' : 'Interviews added'
    });

  } catch (err) {
    console.error('❌ Create user error:', err);
    return res.status(500).json({ 
      success: false, 
      message: err.message || 'Failed to create user' 
    });
  }
});

// Log client-side video upload failures so they show up in Railway logs
// instead of only ever appearing in a customer's browser console
app.post('/api/log-upload-failure', (req, res) => {
  const { fileName, status, errText } = req.body || {};
  console.error(`📼❌ Supabase upload failed | file: ${fileName} | status: ${status} | body: ${errText}`);
  res.json({ success: true });
});

// Delete video from Supabase
app.post('/api/delete-video', async (req, res) => {
  try {
    const { fileName } = req.body;

    if (!fileName) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing fileName' 
      });
    }

    if (fileName.includes('..') || fileName.includes('//')) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid fileName' 
      });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

    const deleteUrl = `${SUPABASE_URL}/storage/v1/object/videos/${fileName}`;
    
    const response = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      }
    });

    if (response.ok) {
      console.log(`🗑️  Deleted video: ${fileName}`);
      res.json({ success: true, message: 'Video deleted' });
    } else {
      const errorText = await response.text();
      console.warn(`⚠️  Could not delete video: ${errorText}`);
      res.json({ success: true, message: 'Deletion attempted', warning: errorText });
    }

  } catch (err) {
    console.error('❌ Delete video error:', err);
    res.json({ success: true, message: 'Deletion attempted', error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    services: {
      gemini: !!GOOGLE_API_KEY,
      email: !!RESEND_API_KEY,
      firebase: !!adminDb,
      firebaseAuth: !!adminAuth,
      payhip: !!PAYHIP_API_KEY
    }
  });
});

// SECURITY: 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    message: 'Endpoint not found' 
  });
});

// SECURITY: Error handler (catch all)
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  
  const errorMessage = IS_PRODUCTION ? 
    'Internal server error' : 
    err.message;
  
  res.status(500).json({ 
    success: false, 
    message: errorMessage 
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('----------------------------------------------------');
  console.log(`🚀 Denterview AI Server Running`);
  console.log(`📡 Environment: ${NODE_ENV}`);
  console.log(`📡 Server: http://localhost:${PORT}`);
  console.log(`🔒 Security: ${IS_PRODUCTION ? 'PRODUCTION MODE' : 'DEVELOPMENT MODE'}`);
  console.log(`📦 Payload Limit: 100MB`);
  console.log('----------------------------------------------------');
  console.log('Endpoints:');
  console.log(`  POST /api/analyze - AI Analysis`);
  console.log(`  POST /api/send-email - Email Results`);
  console.log(`  POST /api/payhip-webhook - Payhip Integration`);
  console.log(`  POST /api/create-user - Manual User Creation`);
  console.log(`  POST /api/delete-video - Video Cleanup`);
  console.log(`  GET  /api/health - Health Check`);
  console.log('----------------------------------------------------');
  
  if (!IS_PRODUCTION) {
    console.warn('⚠️  WARNING: Running in DEVELOPMENT mode');
    console.warn('⚠️  Set NODE_ENV=production before deploying');
  }
}); 