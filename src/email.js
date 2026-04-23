/**
 * email.js
 * Sends transactional emails via Resend.
 * All emails to you (the business owner) go to ENQUIRY_TO_EMAIL.
 */

const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ENQUIRY_TO_EMAIL = process.env.ENQUIRY_TO_EMAIL || 'gthangavel1@gmail.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'BuilderAudit <onboarding@resend.dev>';

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
};
