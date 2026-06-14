/**
 * email.js
 * Sends transactional emails via Resend.
 * All emails to you (the business owner) go to ENQUIRY_TO_EMAIL.
 */

const { Resend } = require('resend');
const config = require('./config');

const RESEND_API_KEY = config.RESEND_API_KEY;
const ENQUIRY_TO_EMAIL = config.ENQUIRY_TO_EMAIL || 'gthangavel1@gmail.com';
const FROM_EMAIL = config.FROM_EMAIL || 'BuilderAudit <onboarding@resend.dev>';

if (!RESEND_API_KEY) {
  console.warn('⚠  RESEND_API_KEY not set — email features disabled.');
}

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

function isEnabled() {
  return !!resend;
}

async function sendEnquiryNotification({ service, notes, user, auditUrl, auditId, reportUrl }) {
  if (!resend) {
    console.warn('Email skipped (no Resend key):', service, 'from', user?.email);
    return { skipped: true };
  }

  const serviceLabels = {
    web_rebuild: 'Web design / rebuild',
    seo: 'SEO services',
    photography: 'Professional photography',
    testimonials: 'Testimonial & review gathering',
    managed_service: 'Full done-for-you fix (managed service)',
  };

  const serviceLabel = serviceLabels[service] || service;

  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0F172A">
      <h2 style="margin:0 0 16px;font-size:20px;letter-spacing:-0.01em">New service enquiry</h2>
      <div style="background:#F1F5F9;border-radius:12px;padding:16px;margin-bottom:16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#64748B;font-weight:600;margin-bottom:4px">Service requested</div>
        <div style="font-size:17px;font-weight:600">${serviceLabel}</div>
      </div>

      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
        <tr><td style="padding:6px 0;color:#64748B;width:140px">From</td><td style="padding:6px 0;font-weight:500">${user?.companyName || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#64748B">Email</td><td style="padding:6px 0"><a href="mailto:${user?.email}" style="color:#2F6BFF">${user?.email}</a></td></tr>
        <tr><td style="padding:6px 0;color:#64748B">Business type</td><td style="padding:6px 0">${user?.businessType || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#64748B">Region</td><td style="padding:6px 0">${user?.region || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#64748B">Website audited</td><td style="padding:6px 0"><a href="${auditUrl}" style="color:#2F6BFF">${auditUrl}</a></td></tr>
        <tr><td style="padding:6px 0;color:#64748B">Report</td><td style="padding:6px 0"><a href="${reportUrl}" style="color:#2F6BFF">View report</a></td></tr>
      </table>

      ${notes ? `
      <div style="background:#EFF6FF;border-left:3px solid #2F6BFF;padding:14px 16px;border-radius:8px;margin-bottom:16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#1E40AF;font-weight:600;margin-bottom:6px">Notes from ${user?.companyName || 'client'}</div>
        <div style="font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(notes)}</div>
      </div>
      ` : ''}

      <p style="font-size:13px;color:#64748B;line-height:1.5;margin:16px 0 0">
        Reply directly to this email or contact them at <a href="mailto:${user?.email}" style="color:#2F6BFF">${user?.email}</a>.
      </p>
    </div>
  `;

  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: ENQUIRY_TO_EMAIL,
      replyTo: user?.email,
      subject: `[BuilderAudit] ${serviceLabel} — ${user?.companyName || user?.email}`,
      html,
    });
    return { success: true, id: result?.data?.id };
  } catch (err) {
    console.error('Email send failed:', err);
    return { success: false, error: err.message };
  }
}

async function sendEnquiryConfirmationToUser({ service, user }) {
  if (!resend || !user?.email) return { skipped: true };

  const serviceLabels = {
    web_rebuild: 'Web design / rebuild',
    seo: 'SEO services',
    photography: 'Professional photography',
    testimonials: 'Testimonial & review gathering',
    managed_service: 'Full done-for-you fix (managed service)',
  };

  const serviceLabel = serviceLabels[service] || service;

  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0F172A">
      <h2 style="margin:0 0 12px;font-size:22px;letter-spacing:-0.02em">Thanks for your enquiry</h2>
      <p style="font-size:15px;line-height:1.6;margin:0 0 20px;color:#334155">
        We've received your request for <strong>${serviceLabel}</strong>. One of our forensics team will review your audit and get back to you within one business day.
      </p>
      <div style="background:#F1F5F9;border-radius:10px;padding:16px;font-size:13px;color:#64748B;line-height:1.6">
        You can see the status of your enquiries any time in your <a href="https://builderaudit.co.uk/dashboard" style="color:#2F6BFF">dashboard</a>.
      </div>
      <p style="font-size:12px;color:#64748B;margin-top:24px">— The BuilderAudit team</p>
    </div>
  `;

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: user.email,
      subject: `We got your enquiry — ${serviceLabel}`,
      html,
    });
    return { success: true };
  } catch (err) {
    console.warn('Confirmation email failed:', err.message);
    return { success: false };
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ═══════════════════════════════════════════════════════════════════════════
   WEEKLY CHECK-IN EMAIL
   Sent every Monday to users who opted in. Shows score delta + what changed.
   ═══════════════════════════════════════════════════════════════════════════ */
async function sendWeeklyCheckIn({ user, audit, previousScore, newScore, changeSummary, appBaseUrl }) {
  if (!resend || !user?.email) return { skipped: true };

  const base = appBaseUrl || 'https://builderaudit.co.uk';
  const reportUrl = `${base}/report/${audit.id}`;
  const dashboardUrl = `${base}/dashboard`;
  const unsubUrl = `${base}/dashboard?setting=weekly_email`;

  const delta = newScore - previousScore;
  const deltaDisplay =
    delta > 0 ? `<span style="color:#6b8e6f">&uarr; +${delta}</span>` :
    delta < 0 ? `<span style="color:#c44f4f">&darr; ${delta}</span>` :
    `<span style="color:#8a7e72">&middot; no change</span>`;

  // Domain for subject line
  let domain = '';
  try { domain = new URL(audit.url).hostname.replace(/^www\./, ''); }
  catch (e) { domain = audit.url; }

  const subject = delta > 0
    ? `Your trust score went up ${delta} points — ${domain}`
    : delta < 0
    ? `Heads up: your trust score dropped — ${domain}`
    : `Your weekly BuilderAudit check-in — ${domain}`;

  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#3a2e33;background:#f2ead9">
      <div style="background:#fff;border-radius:18px;padding:28px 24px;border:1px solid rgba(58,46,51,0.1);box-shadow:0 4px 16px rgba(58,46,51,0.06)">

        <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c88691;margin-bottom:10px">Your weekly check-in</div>
        <h2 style="margin:0 0 10px;font-size:22px;letter-spacing:-0.02em;line-height:1.25">${escapeHtml(user.companyName || 'Your site')} &middot; ${escapeHtml(domain)}</h2>

        <!-- Score row -->
        <div style="display:flex;align-items:center;gap:20px;margin:22px 0 20px;padding:20px;background:#f2ead9;border-radius:14px">
          <div style="font-size:48px;font-weight:800;letter-spacing:-0.03em;color:#3a2e33;line-height:1">${newScore}</div>
          <div style="flex:1">
            <div style="font-size:14px;font-weight:600;color:#5c5147;margin-bottom:4px">Current trust score</div>
            <div style="font-size:18px;font-weight:700;letter-spacing:-0.01em">${deltaDisplay} ${delta !== 0 ? 'since last week' : ''}</div>
            <div style="font-size:12px;color:#8a7e72;margin-top:4px">Previously: ${previousScore}</div>
          </div>
        </div>

        ${changeSummary ? `
        <div style="background:#f2ead9;border-left:3px solid #dea6af;padding:14px 16px;border-radius:8px;margin-bottom:20px;font-size:14px;line-height:1.55">
          <div style="font-size:11px;font-weight:700;color:#c88691;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">What changed</div>
          ${escapeHtml(changeSummary)}
        </div>
        ` : ''}

        <!-- Big CTA -->
        <a href="${reportUrl}" style="display:block;padding:14px 20px;background:#dea6af;color:#3a2e33;text-align:center;border-radius:12px;text-decoration:none;font-size:15px;font-weight:700;letter-spacing:-0.005em;margin-bottom:14px">
          Open your full report &rarr;
        </a>

        <div style="font-size:12px;color:#8a7e72;line-height:1.6;text-align:center">
          Based on re-analysis of your stored audit data. For a full re-crawl of your site, run a fresh audit from your dashboard.
        </div>
      </div>

      <!-- Footer -->
      <div style="text-align:center;padding:20px;font-size:11px;color:#8a7e72;line-height:1.6">
        You're receiving this because you opted into weekly check-ins.<br>
        <a href="${unsubUrl}" style="color:#6b5a5f">Manage email preferences</a> &middot; <a href="${dashboardUrl}" style="color:#6b5a5f">Dashboard</a>
      </div>
    </div>
  `;

  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: user.email,
      subject,
      html,
    });
    return { success: true, id: result?.data?.id };
  } catch (err) {
    console.error('Weekly email failed for', user.email, ':', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  isEnabled,
  sendEnquiryNotification,
  sendEnquiryConfirmationToUser,
  sendWeeklyCheckIn,
  sendAuditReady,
  sendBuilderMatchLead,
  sendNewSignupNotification,
  sendReportLeadNotification,
  sendFeedbackNotification,
  sendVerificationEmail,
};

/* ═══════════════════════════════════════════════════════════════════════════
   BUILDER MATCH LEAD — sent to ENQUIRY_TO_EMAIL when a homeowner signs up
   for the free builder-matching service. Contains full project details.
   ═══════════════════════════════════════════════════════════════════════════ */
async function sendBuilderMatchLead({ lead }) {
  if (!resend) {
    console.warn('Email skipped (no Resend key): builder-match lead from', lead?.email);
    return { skipped: true };
  }

  const row = (label, val) => `<tr><td style="padding:6px 0;color:#64748B;width:170px;vertical-align:top">${label}</td><td style="padding:6px 0;font-weight:500">${val || '—'}</td></tr>`;

  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0F172A">
      <h2 style="margin:0 0 6px;font-size:20px;letter-spacing:-0.01em">🏗 New builder-match lead</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#64748B">A homeowner has signed up for the trusted builder matching service.</p>

      <div style="background:#FFD24D;border-radius:12px;padding:16px;margin-bottom:18px;border:2px solid #1B1A17">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#5C5851;font-weight:700;margin-bottom:4px">Project</div>
        <div style="font-size:17px;font-weight:700">${lead.projectType || 'Not specified'} · ${lead.budget || 'Budget TBC'}</div>
        <div style="font-size:13px;margin-top:4px">${lead.location || ''}</div>
      </div>

      <h3 style="margin:0 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#64748B">Contact</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px">
        ${row('Name', lead.name)}
        ${row('Email', `<a href="mailto:${lead.email}" style="color:#2F6BFF">${lead.email}</a>`)}
        ${row('Phone', lead.phone)}
        ${row('Location / postcode', lead.location)}
      </table>

      <h3 style="margin:0 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#64748B">Project details</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px">
        ${row('Project type', lead.projectType)}
        ${row('Budget', lead.budget)}
        ${row('Timeline', lead.timeline)}
        ${row('Drawings / plans', lead.hasPlans)}
        ${row('Planning permission', lead.planningStatus)}
        ${row('Description', lead.description)}
      </table>

      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#64748B">
        ${row('Marketing consent', lead.consentAgency ? 'YES — agreed to recommendations & services contact' : 'No')}
        ${row('Submitted', new Date().toISOString())}
      </table>
    </div>`;

  return resend.emails.send({
    from: FROM_EMAIL,
    to: config.ENQUIRY_TO_EMAIL || FROM_EMAIL,
    subject: `🏗 Builder-match lead: ${lead.projectType || 'project'} in ${lead.location || 'UK'} (${lead.budget || 'budget TBC'})`,
    html,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUDIT-READY NOTIFICATION EMAIL
   Sent when a user opts in to "email me when ready" while the audit is running.
   Subject line and CTA optimised to get them back to the report ASAP.
   ═══════════════════════════════════════════════════════════════════════════ */
async function sendAuditReady({ email, auditId, auditUrl, score, appBaseUrl }) {
  if (!resend || !email) {
    console.warn('[email] sendAuditReady skipped — no Resend or no email');
    return { skipped: true };
  }

  const base = appBaseUrl || 'https://builderaudit.co.uk';
  const reportUrl = `${base}/dashboard?id=${auditId}`;

  let domain = '';
  try { domain = new URL(auditUrl).hostname.replace(/^www\./, ''); }
  catch (e) { domain = auditUrl; }

  const subject = score != null
    ? `Your BuilderAudit is ready — ${domain} scored ${score}/100`
    : `Your BuilderAudit is ready — ${domain}`;

  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1B1A17;background:#FBF5E1">
      <div style="background:#fff;border:3px solid #1B1A17;border-radius:14px;padding:32px 28px;box-shadow:6px 6px 0 #1B1A17">

        <div style="font-family:'Hanken Grotesk',Hanken Grotesk,sans-serif;font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#5247B8;margin-bottom:14px">BuilderAudit · Report ready</div>

        <h2 style="margin:0 0 10px;font-family:'Hanken Grotesk',Hanken Grotesk,sans-serif;font-weight:900;font-size:28px;letter-spacing:-0.02em;line-height:1;text-transform:uppercase">Your audit's done</h2>

        <p style="font-size:15px;line-height:1.5;margin:0 0 20px;color:#1B1A17">
          We've finished forensically reviewing <strong>${escapeHtml(domain)}</strong> like a real homeowner would — photos, reviews, trust signals, the lot.
        </p>

        ${score != null ? `
        <div style="background:#FBF5E1;border:2px solid #1B1A17;border-radius:10px;padding:18px 20px;margin:0 0 22px;display:table;width:calc(100% - 44px)">
          <div style="display:table-cell;vertical-align:middle;font-family:'Hanken Grotesk',Hanken Grotesk,sans-serif;font-weight:900;font-size:48px;letter-spacing:-0.03em;color:#1B1A17;line-height:1">${score}</div>
          <div style="display:table-cell;vertical-align:middle;padding-left:18px">
            <div style="font-size:13px;font-weight:600;color:#5C5851;letter-spacing:0.02em">Your trust score</div>
            <div style="font-size:14px;font-weight:700;color:#1B1A17;margin-top:2px">out of 100</div>
          </div>
        </div>
        ` : ''}

        <a href="${reportUrl}" style="display:block;padding:15px 22px;background:#5247B8;color:#fff;text-align:center;border:2px solid #1B1A17;border-radius:6px;text-decoration:none;font-family:'IBM Plex Sans',sans-serif;font-weight:700;font-size:16px;box-shadow:4px 4px 0 #1B1A17;margin:0 0 18px">
          See my full report →
        </a>

        <div style="font-size:13px;color:#5C5851;line-height:1.6;text-align:center;padding-top:10px;border-top:1px solid #E8E2D6">
          This link will work whenever you're ready to look. Bookmark it for later if you can't dive in now.
        </div>
      </div>

      <div style="text-align:center;padding:18px 12px 0;font-size:11px;color:#8A7E72;line-height:1.6">
        Sent because you asked us to email you when this audit was ready.<br>
        <a href="${base}" style="color:#5247B8;text-decoration:none">BuilderAudit</a> · Forensic website audits for UK builders
      </div>
    </div>
  `;

  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject,
      html,
    });
    console.log('[email] sendAuditReady sent to', email, 'for audit', auditId);
    return { success: true, id: result?.data?.id };
  } catch (err) {
    console.error('[email] sendAuditReady failed for', email, ':', err.message);
    return { success: false, error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   NEW ACCOUNT NOTIFICATION — sent to you whenever someone creates an account.
   ═══════════════════════════════════════════════════════════════════════════ */
async function sendNewSignupNotification({ user }) {
  if (!resend) { console.warn('Email skipped (no Resend key): new signup', user?.email); return { skipped: true }; }
  const row = (label, val) => `<tr><td style="padding:6px 0;color:#64748B;width:160px;vertical-align:top">${label}</td><td style="padding:6px 0;font-weight:500">${val || '—'}</td></tr>`;
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0F172A">
      <h2 style="margin:0 0 6px;font-size:20px;letter-spacing:-0.01em">👤 New BuilderAudit account</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#64748B">Someone just created an account.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px">
        ${row('Name', user.name || user.company_name)}
        ${row('Email', `<a href="mailto:${user.email}" style="color:#2F6BFF">${user.email}</a>`)}
        ${row('Company', user.company_name)}
        ${row('Phone', user.phone)}
        ${row('Business type', user.business_type)}
        ${row('Region', user.region)}
        ${row('Created', new Date().toISOString())}
      </table>
    </div>`;
  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: ENQUIRY_TO_EMAIL,
      subject: `👤 New account: ${user.company_name || user.name || user.email}`,
      html,
    });
    return { success: true, id: result?.data?.id };
  } catch (err) {
    console.error('[email] sendNewSignupNotification failed:', err.message);
    return { success: false, error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   FEEDBACK NOTIFICATION — sent to you whenever someone uses the feedback widget.
   ═══════════════════════════════════════════════════════════════════════════ */
async function sendFeedbackNotification({ feedback, user }) {
  if (!resend) { console.warn('Email skipped (no Resend key): feedback'); return { skipped: true }; }
  const row = (label, val) => `<tr><td style="padding:6px 0;color:#64748B;width:140px;vertical-align:top">${label}</td><td style="padding:6px 0;font-weight:500">${val || '—'}</td></tr>`;
  const kindLabel = { error: '🐞 Error / inaccurate audit', idea: '💡 Idea / feedback', other: '💬 Other' }[feedback.kind] || '💬 Feedback';
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0F172A">
      <h2 style="margin:0 0 6px;font-size:20px;letter-spacing:-0.01em">${kindLabel}</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#64748B">New feedback from the in-app widget.</p>
      <div style="background:#FBF5E1;border:2px solid #1B1A17;border-radius:12px;padding:16px;margin-bottom:18px;white-space:pre-wrap;font-size:15px;line-height:1.5">${(feedback.message||'').replace(/</g,'&lt;')}</div>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${row('Type', kindLabel)}
        ${row('Name', feedback.name)}
        ${row('From', feedback.email ? `<a href="mailto:${feedback.email}" style="color:#2F6BFF">${feedback.email}</a>` : (user?.email || 'anonymous'))}
        ${row('Account', user ? (user.company_name || user.email) : 'not logged in')}
        ${row('Page', feedback.pageUrl)}
        ${row('Submitted', new Date().toISOString())}
      </table>
    </div>`;
  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: ENQUIRY_TO_EMAIL,
      subject: `${kindLabel} — BuilderAudit feedback`,
      html,
    });
    return { success: true, id: result?.data?.id };
  } catch (err) {
    console.error('[email] sendFeedbackNotification failed:', err.message);
    return { success: false, error: err.message };
  }
}
async function sendReportLeadNotification({ lead, reportCompany, reportUrl }) {
  if (!resend) { console.warn('Email skipped (no Resend key): report lead', lead?.email); return { skipped: true }; }
  const row = (label, val) => `<tr><td style="padding:6px 0;color:#64748B;width:160px;vertical-align:top">${label}</td><td style="padding:6px 0;font-weight:500">${val || '—'}</td></tr>`;
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0F172A">
      <h2 style="margin:0 0 6px;font-size:20px;letter-spacing:-0.01em">📄 New report view</h2>
      <p style="margin:0 0 18px;font-size:14px;color:#64748B">Someone entered their details to view a shared trust report${reportCompany ? ' for <b>' + reportCompany + '</b>' : ''}.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:18px">
        ${row('Name', lead.name)}
        ${row('Email', `<a href="mailto:${lead.email}" style="color:#2F6BFF">${lead.email}</a>`)}
        ${row('Company', lead.company)}
        ${row('Report viewed', reportCompany)}
        ${reportUrl ? row('Link', `<a href="${reportUrl}" style="color:#2F6BFF">${reportUrl}</a>`) : ''}
        ${row('Viewed', new Date().toISOString())}
      </table>
    </div>`;
  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: ENQUIRY_TO_EMAIL,
      subject: `📄 Report view: ${lead.name}${lead.company ? ' (' + lead.company + ')' : ''}`,
      html,
    });
    return { success: true, id: result?.data?.id };
  } catch (err) {
    console.error('[email] sendReportLeadNotification failed:', err.message);
    return { success: false, error: err.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   EMAIL VERIFICATION — sent to the USER at signup with a one-time link they
   must click to confirm the address is real and theirs.
   ═══════════════════════════════════════════════════════════════════════════ */
async function sendVerificationEmail({ to, name, verifyUrl }) {
  if (!resend || !to) {
    console.warn('[email] sendVerificationEmail skipped — no Resend key or no recipient');
    return { skipped: true };
  }
  const who = (name && String(name).trim()) ? String(name).trim() : 'there';
  const html = `
    <div style="font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1B1A17;background:#FBF5E1">
      <div style="background:#fff;border:3px solid #1B1A17;border-radius:14px;padding:32px 28px;box-shadow:6px 6px 0 #1B1A17">
        <div style="font-family:'Hanken Grotesk',sans-serif;font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:#5247B8;margin-bottom:14px">BuilderAudit · Confirm your email</div>
        <h2 style="margin:0 0 10px;font-family:'Hanken Grotesk',sans-serif;font-weight:900;font-size:26px;letter-spacing:-0.02em;line-height:1.05;text-transform:uppercase">One quick step, ${escapeHtml(who)}</h2>
        <p style="font-size:15px;line-height:1.55;margin:0 0 22px;color:#1B1A17">
          Please confirm this is your email address so we can finish setting up your BuilderAudit account. Just tap the button below.
        </p>
        <a href="${verifyUrl}" style="display:block;padding:15px 22px;background:#5247B8;color:#fff;text-align:center;border:2px solid #1B1A17;border-radius:6px;text-decoration:none;font-family:'IBM Plex Sans',sans-serif;font-weight:700;font-size:16px;box-shadow:4px 4px 0 #1B1A17;margin:0 0 18px">
          Confirm my email →
        </a>
        <div style="font-size:12.5px;color:#5C5851;line-height:1.6;padding-top:12px;border-top:1px solid #E8E2D6">
          If the button doesn't work, copy and paste this link into your browser:<br>
          <span style="word-break:break-all;color:#5247B8">${verifyUrl}</span>
        </div>
        <div style="font-size:12px;color:#8A7E72;line-height:1.6;margin-top:14px">
          This link expires in 7 days. If you didn't create a BuilderAudit account, you can safely ignore this email.
        </div>
      </div>
    </div>`;
  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: 'Confirm your email — BuilderAudit',
      html,
    });
    console.log('[email] sendVerificationEmail sent to', to);
    return { success: true, id: result?.data?.id };
  } catch (err) {
    console.error('[email] sendVerificationEmail failed for', to, ':', err.message);
    return { success: false, error: err.message };
  }
}
