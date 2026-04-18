#!/usr/bin/env node
/**
 * Partner Report Generator — Daybreak
 * Produces branded HTML patient-progress reports per Location account from Salesforce.
 *
 * Usage: node runner.js [--window last-7-days] [--accounts ID1,ID2] [--out path] [--dry-run]
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Brand palette ---
const BRAND = {
  sunlight: '#FECF00',
  deepSleep: '#221D35',
  pillow: '#FFFFFF',
  sky: '#DDE4ED',
  linen: '#F6ECE1',
};

// --- Stuck-patient thresholds (days) ---
const STUCK_THRESHOLDS = {
  notActivated: 1,
  epworthIncomplete: 3,
  holdNotReleased: 7,
  noRx: 7,
  noConversion: 14,
};

// Patients stuck longer than this are treated as long-inactive / likely abandoned.
// They still surface in a collapsed section — just out of the main action list.
const ABANDONED_DAYS_DEFAULT = 90;

const USAGE = `
Usage: node runner.js [options]

Options:
  --window <spec>        Date window. Default: last-7-days
                         Formats: last-N-days | this-month | last-month | YYYY-MM
                                  this-quarter | last-quarter | YYYY-MM-DD:YYYY-MM-DD
  --accounts <ids>       Comma-separated Location Account IDs (default: all owned by user)
  --out <path>           Output directory (default: output/partner-reports/<today>/)
  --abandoned-days <n>   Stuck >N days moves to collapsible long-inactive section (default: 90)
  --no-compare           Disable period-over-period comparison (default: compare enabled)
  --dry-run              Run queries and log counts; skip file writes
  --help                 Show this message
`.trim();

// ===== CLI =====

function parseArgs(argv) {
  const args = {
    window: 'last-7-days', accounts: null, out: null, dryRun: false,
    abandonedDays: ABANDONED_DAYS_DEFAULT, compare: true,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--window') args.window = argv[++i];
    else if (a === '--accounts') args.accounts = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--abandoned-days') args.abandonedDays = parseInt(argv[++i], 10);
    else if (a === '--no-compare') args.compare = false;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') { console.log(USAGE); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); console.error(USAGE); process.exit(1); }
  }
  return args;
}

// ===== Dates / window =====

function parseWindow(spec) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let start, end, label;
  let m;

  if ((m = spec.match(/^last-(\d+)-days$/))) {
    const n = parseInt(m[1], 10);
    end = new Date(today);
    start = new Date(today);
    start.setDate(start.getDate() - (n - 1));
    label = `Last ${n} days`;
  } else if (spec === 'this-month') {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
    end = new Date(today);
    label = start.toLocaleString('en-US', { month: 'long', year: 'numeric' }) + ' (month-to-date)';
  } else if (spec === 'last-month') {
    start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    end = new Date(today.getFullYear(), today.getMonth(), 0);
    label = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  } else if ((m = spec.match(/^(\d{4})-(\d{2})$/))) {
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10) - 1;
    start = new Date(y, mo, 1);
    end = new Date(y, mo + 1, 0);
    label = start.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  } else if (spec === 'this-quarter') {
    const q = Math.floor(today.getMonth() / 3);
    start = new Date(today.getFullYear(), q * 3, 1);
    end = new Date(today);
    label = `Q${q + 1} ${today.getFullYear()} (quarter-to-date)`;
  } else if (spec === 'last-quarter') {
    const currentQ = Math.floor(today.getMonth() / 3);
    const lastQ = currentQ === 0 ? 3 : currentQ - 1;
    const y = currentQ === 0 ? today.getFullYear() - 1 : today.getFullYear();
    start = new Date(y, lastQ * 3, 1);
    end = new Date(y, lastQ * 3 + 3, 0);
    label = `Q${lastQ + 1} ${y}`;
  } else if ((m = spec.match(/^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/))) {
    start = new Date(m[1] + 'T00:00:00');
    end = new Date(m[2] + 'T00:00:00');
    label = `${fmtHuman(start)} – ${fmtHuman(end)}`;
  } else {
    throw new Error(`Unrecognized --window: ${spec}`);
  }

  return { start, end, spec, label };
}

function fmtDate(d) { return d.toISOString().slice(0, 10); }
function fmtHuman(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Given a window, return the prior period of equivalent scope.
// last-N-days  -> prior N days immediately before
// this-month   -> last calendar month
// last-month   -> month before that
// YYYY-MM      -> preceding calendar month
// this-quarter -> last calendar quarter
// last-quarter -> quarter before that
// absolute X:Y -> same-length range immediately before X
function priorPeriod(w) {
  const spec = w.spec;
  const DAY = 24 * 60 * 60 * 1000;
  let m;

  if ((m = spec.match(/^last-(\d+)-days$/))) {
    const n = parseInt(m[1], 10);
    const end = new Date(w.start.getTime() - DAY);
    const start = new Date(end.getTime() - (n - 1) * DAY);
    return { start, end, label: `prior ${n} days` };
  }
  if (spec === 'this-month' || spec === 'last-month' || spec.match(/^\d{4}-\d{2}$/)) {
    const start = new Date(w.start.getFullYear(), w.start.getMonth() - 1, 1);
    const end = new Date(w.start.getFullYear(), w.start.getMonth(), 0);
    return { start, end, label: `prior month (${start.toLocaleString('en-US', { month: 'short', year: 'numeric' })})` };
  }
  if (spec === 'this-quarter' || spec === 'last-quarter') {
    const start = new Date(w.start.getFullYear(), w.start.getMonth() - 3, 1);
    const end = new Date(w.start.getFullYear(), w.start.getMonth(), 0);
    return { start, end, label: 'prior quarter' };
  }
  // Absolute or fallback: same-length window immediately before
  const lenDays = Math.round((w.end - w.start) / DAY) + 1;
  const end = new Date(w.start.getTime() - DAY);
  const start = new Date(end.getTime() - (lenDays - 1) * DAY);
  return { start, end, label: `prior ${lenDays} days` };
}

function inWindow(dateStr, w) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const dayOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const t = dayOf(d), s = dayOf(w.start), e = dayOf(w.end);
  return t >= s && t <= e;
}

function daysSince(dateStr, now) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Math.floor((now - d) / (24 * 60 * 60 * 1000));
}

// ===== Salesforce CLI wrappers =====

// On Windows, `sf` is a .cmd wrapper; shell:true lets execFileSync resolve it.
const SF_EXEC_OPTS = { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, shell: true };

function sfQuery(soql) {
  const tmp = path.join(os.tmpdir(), `partner-report-q-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, soql, 'utf8');
  try {
    const out = execFileSync('sf', ['data', 'query', '--result-format', 'json', '--file', `"${tmp}"`], SF_EXEC_OPTS);
    const parsed = JSON.parse(out);
    if (parsed.status !== 0) throw new Error(`sf query failed: ${JSON.stringify(parsed)}`);
    return parsed.result.records || [];
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function currentUser() {
  const out = execFileSync('sf', ['org', 'display', 'user', '--json'], SF_EXEC_OPTS);
  const parsed = JSON.parse(out);
  if (parsed.status !== 0) throw new Error('sf org display user failed');
  return parsed.result;
}

// ===== Queries =====

function queryLocationAccounts(userId, accountIds) {
  // When --accounts is explicit, scope to those IDs regardless of owner
  // (lets us pull partner accounts owned by teammates). Otherwise default
  // to accounts owned by the current user.
  let where;
  if (accountIds && accountIds.length) {
    const ids = accountIds.map(id => `'${id}'`).join(', ');
    where = `RecordType.Name = 'Location' AND Id IN (${ids})`;
  } else {
    where = `RecordType.Name = 'Location' AND OwnerId = '${userId}'`;
  }
  const soql = `
    SELECT Id, Name, OwnerId, Owner.Name, ParentId, Parent.Name, Parent.Billing_Model__c
    FROM Account
    WHERE ${where}
    ORDER BY Name
  `.trim();
  return sfQuery(soql);
}

function queryContactsForAccounts(accountIds) {
  if (!accountIds.length) return [];
  const ids = accountIds.map(id => `'${id}'`).join(', ');
  const soql = `
    SELECT Id, AccountId, RecordType.Name, Patient_ID__c, Referral_MRN__c,
           FirstName, LastName, Birthdate, CreatedDate,
           Cancelled_Date__c,
           Auth0_Registration_Date__c,
           Health_Questionnaire__c,
           Dental_Form_Completed_Timestamp__c,
           IK_Shipped_Date__c, IK_Return_Delivered_Date__c,
           Scan_Accepted_Date__c, Dentist_Review_Completed_Date__c,
           Patient_Consent_Hold_Released__c,
           Pre_Authorization_Hold_Released__c,
           MAD_Manufacturing_Completed_Date__c,
           MAD_Delivered_Date__c,
           Sleep_Test_Interpreted_Date__c,
           Most_Recent_Patient_RX__c,
           S2_Purchase_Date__c,
           Sales_Notes__c
    FROM Contact
    WHERE AccountId IN (${ids})
  `.trim();
  return sfQuery(soql);
}

function isCancelled(c) { return has(c, 'Cancelled_Date__c'); }

// Contact RecordType filter per variant.
// Billing  → 'Customer - PRO' only
// Referral → 'Customer - DTC' only
// Provider and any other types are excluded (they're not patients).
const CONTACT_TYPE_BY_VARIANT = {
  Billing: 'Customer - PRO',
  Referral: 'Customer - DTC',
};
function filterContactsForVariant(contacts, variant) {
  const want = CONTACT_TYPE_BY_VARIANT[variant];
  return contacts.filter(c => c.RecordType && c.RecordType.Name === want);
}

// ===== Metrics =====

function has(c, field) {
  const v = c[field];
  return v !== null && v !== undefined && v !== '' && v !== false;
}

// PHI-safe patient identifier
function patientId(c) {
  if (c.Patient_ID__c) return String(c.Patient_ID__c);
  if (c.Referral_MRN__c) return String(c.Referral_MRN__c);
  const f = (c.FirstName || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, '_');
  const l = (c.LastName || '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase().padEnd(3, '_');
  const dob = c.Birthdate ? c.Birthdate : 'UNK';
  return `${f}-${l}-${dob}`;
}

// Stage sequences (ordered). Each stage has a date field; we pick the
// latest stage whose date is populated as the "current stage".
const BILLING_STAGES = [
  { name: 'Submitted',           field: 'CreatedDate' },
  { name: 'Activated',           field: 'Auth0_Registration_Date__c' },
  { name: 'Dental form done',    field: 'Dental_Form_Completed_Timestamp__c' },
  { name: 'IK shipped',          field: 'IK_Shipped_Date__c' },
  { name: 'IK returned',         field: 'IK_Return_Delivered_Date__c' },
  { name: 'Impression accepted', field: 'Scan_Accepted_Date__c' },
  { name: 'Dentist approved',    field: 'Dentist_Review_Completed_Date__c' },
  { name: 'Manufactured',        field: 'MAD_Manufacturing_Completed_Date__c' },
  { name: 'Delivered',           field: 'MAD_Delivered_Date__c' },
];
const REFERRAL_STAGES = [
  { name: 'Referred',               field: 'CreatedDate' },
  { name: 'Activated',              field: 'Auth0_Registration_Date__c' },
  { name: 'Sleep test interpreted', field: 'Sleep_Test_Interpreted_Date__c' },
  { name: 'Rx written',             field: 'Most_Recent_Patient_RX__c' },
  { name: 'Converted (S2)',         field: 'S2_Purchase_Date__c' },
  { name: 'Delivered',              field: 'MAD_Delivered_Date__c' },
];

function currentStage(c, stages, now) {
  let current = { name: 'Unknown', date: null };
  for (const s of stages) {
    if (has(c, s.field)) current = { name: s.name, date: c[s.field] };
  }
  return { ...current, daysAtStage: daysSince(current.date, now) };
}

function nextStep(c, variant) {
  if (has(c, 'MAD_Delivered_Date__c')) return 'Complete — in therapy';
  const activated = has(c, 'Auth0_Registration_Date__c');
  if (variant === 'Billing') {
    if (!activated)                                      return 'Patient: complete activation';
    if (!has(c, 'Health_Questionnaire__c'))              return 'Patient: complete Epworth';
    if (c.Patient_Consent_Hold_Released__c !== true)     return 'Partner: release Consent Hold';
    if (c.Pre_Authorization_Hold_Released__c !== true)   return 'Partner: release Pre-Auth Hold';
    if (!has(c, 'IK_Shipped_Date__c'))                   return 'Daybreak: ship impression kit';
    if (!has(c, 'IK_Return_Delivered_Date__c'))          return 'Patient: return impression kit';
    if (!has(c, 'Scan_Accepted_Date__c'))                return 'Daybreak: accept impressions';
    if (!has(c, 'Dentist_Review_Completed_Date__c'))     return 'Dentist: review plan';
    if (!has(c, 'MAD_Manufacturing_Completed_Date__c'))  return 'Daybreak: manufacture device';
    return 'Daybreak: deliver device';
  }
  if (!activated)                                  return 'Patient: complete activation';
  if (!has(c, 'Most_Recent_Patient_RX__c'))        return 'Daybreak clinical: write Rx';
  if (!has(c, 'S2_Purchase_Date__c'))              return 'S2 sales: convert patient';
  return 'Daybreak: deliver device';
}

const ACTIVITY_FIELDS = [
  'CreatedDate', 'Auth0_Registration_Date__c', 'Dental_Form_Completed_Timestamp__c',
  'IK_Shipped_Date__c', 'IK_Return_Delivered_Date__c', 'Scan_Accepted_Date__c',
  'Dentist_Review_Completed_Date__c', 'MAD_Manufacturing_Completed_Date__c',
  'MAD_Delivered_Date__c', 'Sleep_Test_Interpreted_Date__c', 'S2_Purchase_Date__c',
];
function lastActivity(c, now) {
  let latest = null;
  for (const f of ACTIVITY_FIELDS) {
    if (has(c, f)) {
      const d = new Date(c[f]);
      if (!latest || d > latest) latest = d;
    }
  }
  return { date: latest, daysAgo: latest ? daysSince(latest, now) : null };
}

function recentPatients(contacts, w, variant, now) {
  const stages = variant === 'Billing' ? BILLING_STAGES : REFERRAL_STAGES;
  return contacts
    .filter(c => inWindow(c.CreatedDate, w))
    .sort((a, b) => new Date(b.CreatedDate) - new Date(a.CreatedDate))
    .map(c => ({
      pid: patientId(c),
      location: c._accountName || null,
      submittedDays: daysSince(c.CreatedDate, now),
      stage: currentStage(c, stages, now),
      activity: lastActivity(c, now),
      next: nextStep(c, variant),
      salesNotes: c.Sales_Notes__c || null,
    }));
}

function billingPeriod(contacts, w) {
  return {
    newSubmissions: contacts.filter(c => inWindow(c.CreatedDate, w)).length,
    newActivations: contacts.filter(c => inWindow(c.Auth0_Registration_Date__c, w)).length,
    newDeliveries: contacts.filter(c => inWindow(c.MAD_Delivered_Date__c, w)).length,
  };
}

function referralPeriod(contacts, w) {
  return {
    newSubmissions: contacts.filter(c => inWindow(c.CreatedDate, w)).length,
    newActivations: contacts.filter(c => inWindow(c.Auth0_Registration_Date__c, w)).length,
    newConversions: contacts.filter(c => inWindow(c.S2_Purchase_Date__c, w)).length,
    newDeliveries: contacts.filter(c => inWindow(c.MAD_Delivered_Date__c, w)).length,
  };
}

function billingMetrics(contacts, w, prior) {
  const total = contacts.length;
  const counts = {
    submitted: total,
    activated: contacts.filter(c => has(c, 'Auth0_Registration_Date__c')).length,
    epworthComplete: contacts.filter(c => has(c, 'Health_Questionnaire__c')).length,
    dentalFormComplete: contacts.filter(c => has(c, 'Dental_Form_Completed_Timestamp__c')).length,
    ikShipped: contacts.filter(c => has(c, 'IK_Shipped_Date__c')).length,
    ikReturned: contacts.filter(c => has(c, 'IK_Return_Delivered_Date__c')).length,
    scanAccepted: contacts.filter(c => has(c, 'Scan_Accepted_Date__c')).length,
    dentistApproved: contacts.filter(c => has(c, 'Dentist_Review_Completed_Date__c')).length,
    consentReleased: contacts.filter(c => c.Patient_Consent_Hold_Released__c === true).length,
    preAuthReleased: contacts.filter(c => c.Pre_Authorization_Hold_Released__c === true).length,
    bothHoldsReleased: contacts.filter(c =>
      c.Patient_Consent_Hold_Released__c === true && c.Pre_Authorization_Hold_Released__c === true
    ).length,
    manufactured: contacts.filter(c => has(c, 'MAD_Manufacturing_Completed_Date__c')).length,
    delivered: contacts.filter(c => has(c, 'MAD_Delivered_Date__c')).length,
  };
  return {
    counts,
    period: billingPeriod(contacts, w),
    priorPeriod: prior ? billingPeriod(contacts, prior) : null,
  };
}

function referralMetrics(contacts, w, prior) {
  const total = contacts.length;
  const counts = {
    submitted: total,
    activated: contacts.filter(c => has(c, 'Auth0_Registration_Date__c')).length,
    sleepTestInterpreted: contacts.filter(c => has(c, 'Sleep_Test_Interpreted_Date__c')).length,
    rxWritten: contacts.filter(c => has(c, 'Most_Recent_Patient_RX__c')).length,
    converted: contacts.filter(c => has(c, 'S2_Purchase_Date__c')).length,
    delivered: contacts.filter(c => has(c, 'MAD_Delivered_Date__c')).length,
  };
  return {
    counts,
    period: referralPeriod(contacts, w),
    priorPeriod: prior ? referralPeriod(contacts, prior) : null,
  };
}

// Severity ranking for combining multi-reason rows
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };
function worstSeverity(a, b) { return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b; }

function stuckBilling(contacts, now) {
  const rows = [];
  for (const c of contacts) {
    if (has(c, 'MAD_Delivered_Date__c')) continue; // already done
    const submittedDays = daysSince(c.CreatedDate, now);
    const activatedDays = daysSince(c.Auth0_Registration_Date__c, now);
    const stage = currentStage(c, BILLING_STAGES, now);
    const activity = lastActivity(c, now);
    const location = c._accountName || null;

    // Not activated — early exit, single reason
    if (!has(c, 'Auth0_Registration_Date__c')) {
      if (submittedDays !== null && submittedDays > STUCK_THRESHOLDS.notActivated) {
        rows.push({
          pid: patientId(c), location,
          reason: 'Not activated',
          detail: `Submitted ${submittedDays} days ago`,
          action: 'Nudge patient to complete activation link.',
          severity: submittedDays > 14 ? 'high' : 'medium',
          daysStuck: submittedDays,
          stage, activity,
          salesNotes: c.Sales_Notes__c || null,
          activated: false,
        });
      }
      continue;
    }

    // Activated: collect all applicable stuck reasons into one row per patient
    const reasons = [], actions = [];
    let severity = 'low';

    if (!has(c, 'Health_Questionnaire__c') && activatedDays > STUCK_THRESHOLDS.epworthIncomplete) {
      reasons.push('Epworth incomplete');
      actions.push('Patient has not completed the Epworth Sleep Scale.');
      severity = worstSeverity(severity, 'low');
    }
    if (c.Patient_Consent_Hold_Released__c !== true && activatedDays > STUCK_THRESHOLDS.holdNotReleased) {
      reasons.push('Consent Hold not released');
      actions.push('Collect patient out-of-pocket cost, then click "Patient Consent Hold" in the portal.');
      severity = worstSeverity(severity, 'high');
    }
    if (c.Pre_Authorization_Hold_Released__c !== true && activatedDays > STUCK_THRESHOLDS.holdNotReleased) {
      reasons.push('Pre-Auth Hold not released');
      actions.push('Secure pre-authorization, then click "Pre-Auth Hold" in the portal.');
      severity = worstSeverity(severity, 'high');
    }

    if (reasons.length) {
      rows.push({
        pid: patientId(c), location,
        reason: reasons.join(' · '),
        detail: `Activated ${activatedDays} days ago`,
        action: actions.join(' '),
        severity,
        daysStuck: activatedDays,
        stage, activity,
        salesNotes: c.Sales_Notes__c || null,
        activated: true,
      });
    }
  }
  return rows.sort((a, b) => a.daysStuck - b.daysStuck);
}

function stuckReferral(contacts, now) {
  const rows = [];
  for (const c of contacts) {
    if (has(c, 'MAD_Delivered_Date__c')) continue;
    const submittedDays = daysSince(c.CreatedDate, now);
    const activatedDays = daysSince(c.Auth0_Registration_Date__c, now);
    const stage = currentStage(c, REFERRAL_STAGES, now);
    const activity = lastActivity(c, now);
    const location = c._accountName || null;

    if (!has(c, 'Auth0_Registration_Date__c')) {
      if (submittedDays !== null && submittedDays > STUCK_THRESHOLDS.notActivated) {
        rows.push({
          pid: patientId(c), location,
          reason: 'Not activated',
          detail: `Referred ${submittedDays} days ago`,
          action: 'Patient has not completed activation.',
          severity: submittedDays > 14 ? 'high' : 'medium',
          daysStuck: submittedDays,
          stage, activity,
          salesNotes: c.Sales_Notes__c || null,
          activated: false,
        });
      }
      continue;
    }

    const reasons = [], actions = [];
    let severity = 'low';

    if (!has(c, 'Most_Recent_Patient_RX__c') && activatedDays > STUCK_THRESHOLDS.noRx) {
      reasons.push('No Rx written');
      actions.push('Daybreak clinical team: advance Rx workflow.');
      severity = worstSeverity(severity, 'medium');
    }
    if (has(c, 'Most_Recent_Patient_RX__c') && !has(c, 'S2_Purchase_Date__c') && activatedDays > STUCK_THRESHOLDS.noConversion) {
      reasons.push('Rx written, no conversion');
      actions.push('S2 sales team: follow up with patient.');
      severity = worstSeverity(severity, 'medium');
    }

    if (reasons.length) {
      rows.push({
        pid: patientId(c), location,
        reason: reasons.join(' · '),
        detail: `Activated ${activatedDays} days ago`,
        action: actions.join(' '),
        severity,
        daysStuck: activatedDays,
        stage, activity,
        salesNotes: c.Sales_Notes__c || null,
        activated: true,
      });
    }
  }
  return rows.sort((a, b) => a.daysStuck - b.daysStuck);
}

// ===== HTML rendering (brand template) =====

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function pct(num, den) {
  if (!den) return '—';
  return Math.round((num / den) * 100) + '%';
}

const DAYBREAK_MARK_SVG = `<svg viewBox="0 0 48 32" xmlns="http://www.w3.org/2000/svg" width="36" height="24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true"><ellipse cx="24" cy="12" rx="18" ry="7"/><ellipse cx="24" cy="20" rx="18" ry="7"/></svg>`;

function baseCss() {
  return `
    :root {
      --sunlight: ${BRAND.sunlight};
      --deepsleep: ${BRAND.deepSleep};
      --pillow: ${BRAND.pillow};
      --sky: ${BRAND.sky};
      --linen: ${BRAND.linen};
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
      color: var(--deepsleep);
      background: var(--pillow);
      margin: 0; padding: 0;
      line-height: 1.5;
    }
    .wrap { max-width: 960px; margin: 0 auto; padding: 48px 40px; }
    .brand-bar {
      display: flex; align-items: center; gap: 12px;
      color: var(--deepsleep);
      font-weight: 600; font-size: 20px; letter-spacing: -0.01em;
    }
    .brand-bar .mark { color: var(--deepsleep); display: inline-flex; }
    .hero {
      margin-top: 32px; padding-bottom: 32px; border-bottom: 1px solid rgba(34,29,53,0.1);
    }
    .hero h1 {
      font-size: 42px; line-height: 1.1; margin: 0 0 12px 0; font-weight: 600;
      letter-spacing: -0.02em;
    }
    .hero h1 .accent {
      font-family: Georgia, 'Source Serif Pro', serif;
      font-style: italic; font-weight: 400;
      background: linear-gradient(to top, var(--sunlight) 20%, transparent 20%);
      padding: 0 4px;
    }
    .hero .meta {
      font-size: 14px; color: rgba(34,29,53,0.7); text-transform: uppercase;
      letter-spacing: 0.06em; font-weight: 500;
    }
    .hero .variant-pill {
      display: inline-block; background: var(--deepsleep); color: var(--sunlight);
      padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 600;
      letter-spacing: 0.1em; text-transform: uppercase; margin-left: 8px;
      vertical-align: 2px;
    }
    h2 {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em;
      color: rgba(34,29,53,0.6); font-weight: 600;
      margin: 48px 0 16px 0; padding-bottom: 8px; border-bottom: 1px solid rgba(34,29,53,0.1);
    }
    h3 {
      font-size: 22px; font-weight: 600; margin: 0 0 8px 0; letter-spacing: -0.01em;
    }
    .cards {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 16px 0;
    }
    .card {
      background: var(--linen); padding: 20px; border-radius: 8px;
    }
    .card.highlight { background: var(--deepsleep); color: var(--pillow); }
    .card.highlight .label { color: rgba(254,207,0,0.8); }
    .card .label {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em;
      color: rgba(34,29,53,0.6); font-weight: 600;
    }
    .card .metric { font-size: 36px; font-weight: 600; margin-top: 6px; letter-spacing: -0.02em; }
    .card .sub { font-size: 12px; color: rgba(34,29,53,0.6); margin-top: 4px; }
    .card.highlight .sub { color: rgba(255,255,255,0.7); }
    .funnel { margin: 16px 0; }
    .funnel-row { margin: 6px 0; display: flex; align-items: center; gap: 12px; }
    .funnel-row .stage-label {
      width: 220px; font-size: 13px; color: rgba(34,29,53,0.8); font-weight: 500;
    }
    .funnel-row .bar-wrap {
      flex: 1; background: var(--sky); height: 28px; border-radius: 4px; overflow: hidden;
    }
    .funnel-row .bar {
      height: 100%; background: var(--deepsleep); min-width: 2px;
    }
    .funnel-row .bar-value {
      font-size: 13px; font-weight: 600; color: var(--deepsleep);
      white-space: nowrap; min-width: 92px;
    }
    .callout {
      background: var(--sky); padding: 18px 22px; border-radius: 8px;
      margin: 24px 0; font-size: 14px; color: var(--deepsleep);
    }
    .callout.attention {
      background: var(--sunlight); color: var(--deepsleep);
    }
    .stuck-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    .stuck-table thead th {
      text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em;
      color: rgba(34,29,53,0.6); padding: 12px 12px; border-bottom: 1px solid rgba(34,29,53,0.1);
      font-weight: 600;
    }
    .stuck-table tbody tr {
      border-bottom: 1px solid rgba(34,29,53,0.06);
    }
    .stuck-table tbody tr.high td:first-child {
      border-left: 3px solid var(--sunlight); padding-left: 9px;
    }
    .stuck-table tbody tr.medium td:first-child {
      border-left: 3px solid rgba(34,29,53,0.4); padding-left: 9px;
    }
    .stuck-table tbody tr.low td:first-child {
      border-left: 3px solid var(--sky); padding-left: 9px;
    }
    .stuck-table td {
      padding: 14px 12px; font-size: 13px; vertical-align: top;
    }
    .stuck-table td.pid { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .stuck-table td.days {
      white-space: nowrap; font-weight: 600;
    }
    .severity-chip {
      display: inline-block; font-size: 10px; padding: 2px 8px; border-radius: 10px;
      text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600;
    }
    .severity-chip.high { background: var(--sunlight); color: var(--deepsleep); }
    .severity-chip.medium { background: var(--sky); color: var(--deepsleep); }
    .severity-chip.low { background: var(--linen); color: rgba(34,29,53,0.7); }
    .empty-state {
      padding: 32px; text-align: center; background: var(--linen); border-radius: 8px;
      color: rgba(34,29,53,0.6); font-size: 14px;
    }
    .footer {
      margin-top: 64px; padding: 24px 0; border-top: 1px solid rgba(34,29,53,0.1);
      font-size: 11px; color: rgba(34,29,53,0.5); text-align: center;
      text-transform: uppercase; letter-spacing: 0.12em;
    }
    .delta { font-weight: 600; margin-right: 4px; }
    .delta.up   { color: #2d7a4f; }
    .delta.down { color: #9c3a2c; }
    .delta.flat { color: rgba(34,29,53,0.5); }
    details.long-inactive {
      margin-top: 24px; background: var(--linen); border-radius: 8px; padding: 4px 18px;
    }
    details.long-inactive summary {
      cursor: pointer; padding: 14px 0; font-size: 13px; font-weight: 600;
      color: rgba(34,29,53,0.75); letter-spacing: 0.02em;
      list-style: none; user-select: none;
    }
    details.long-inactive summary::-webkit-details-marker { display: none; }
    details.long-inactive summary::before {
      content: '▸'; display: inline-block; margin-right: 10px; transition: transform 0.15s;
      color: rgba(34,29,53,0.5);
    }
    details.long-inactive[open] summary::before { transform: rotate(90deg); }
    details.long-inactive[open] summary { border-bottom: 1px solid rgba(34,29,53,0.08); margin-bottom: 8px; }
    @media (max-width: 720px) {
      .wrap { padding: 32px 20px; }
      .hero h1 { font-size: 30px; }
      .cards { grid-template-columns: 1fr; }
      .funnel-row .stage-label { width: 140px; font-size: 12px; }
    }
    @media print {
      .wrap { max-width: none; padding: 24px; }
    }
  `;
}

function funnelRow(label, count, total) {
  const pctVal = total ? (count / total) * 100 : 0;
  const pctStr = total ? pct(count, total) : '—';
  return `
    <div class="funnel-row">
      <div class="stage-label">${esc(label)}</div>
      <div class="bar-wrap">
        <div class="bar" style="width:${pctVal.toFixed(1)}%"></div>
      </div>
      <div class="bar-value">${count} · ${pctStr}</div>
    </div>
  `;
}

function metricCard(label, value, sub, highlight) {
  return `
    <div class="card${highlight ? ' highlight' : ''}">
      <div class="label">${esc(label)}</div>
      <div class="metric">${esc(value)}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
    </div>
  `;
}

// Metric card with period-over-period delta.
// If prior is null (compare disabled) falls back to plain metric card with sub.
function deltaCard(label, current, prior, priorLabel) {
  let deltaHtml = '';
  let subText = '';
  if (prior != null) {
    const diff = current - prior;
    const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
    const arrow = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    const pctSuffix = prior === 0
      ? (current === 0 ? '' : ' (new)')
      : ` (${diff >= 0 ? '+' : ''}${Math.round((diff / prior) * 100)}%)`;
    deltaHtml = `<span class="delta ${dir}">${arrow} ${Math.abs(diff)}${pctSuffix}</span>`;
    subText = `vs ${prior} in ${priorLabel}`;
  } else {
    subText = priorLabel ? `in ${priorLabel}` : '';
  }
  return `
    <div class="card">
      <div class="label">${esc(label)}</div>
      <div class="metric">${esc(current)}</div>
      <div class="sub">${deltaHtml}${deltaHtml && subText ? ' ' : ''}${esc(subText)}</div>
    </div>
  `;
}

function stuckTable(rows, opts) {
  opts = opts || {};
  const showLocation = !!opts.showLocation;
  if (!rows.length) {
    return `<div class="empty-state">No stuck patients in this account. Nice.</div>`;
  }
  const locHeader = showLocation ? `<th>Location</th>` : '';
  const body = rows.map(r => {
    const locCell = showLocation ? `<td style="font-size:12px;">${esc(r.location || '—')}</td>` : '';
    const stageStr = r.stage && r.stage.name !== 'Unknown'
      ? `${esc(r.stage.name)}${r.stage.daysAtStage != null ? ` · <span style="color:rgba(34,29,53,0.55);">${r.stage.daysAtStage}d</span>` : ''}`
      : '—';
    const activityStr = r.activity && r.activity.daysAgo != null
      ? `${r.activity.daysAgo}d ago`
      : '—';
    const salesStr = r.salesNotes
      ? `<span style="font-size:12px;">${esc(r.salesNotes)}</span>`
      : `<span style="color:rgba(34,29,53,0.35); font-size:12px;">—</span>`;
    return `
    <tr class="${r.severity}">
      <td class="pid">${esc(r.pid)}</td>
      ${locCell}
      <td>${esc(r.reason)}<br><span style="color:rgba(34,29,53,0.55); font-size:12px;">${esc(r.detail)}</span></td>
      <td style="font-size:12px;">${stageStr}</td>
      <td style="font-size:12px; color:rgba(34,29,53,0.7);">${activityStr}</td>
      <td>${esc(r.action)}</td>
      <td style="max-width:220px;">${salesStr}</td>
      <td class="days">${r.daysStuck}d</td>
      <td><span class="severity-chip ${r.severity}">${esc(r.severity)}</span></td>
    </tr>
    `;
  }).join('');
  return `
    <table class="stuck-table">
      <thead>
        <tr>
          <th>Patient ID</th>
          ${locHeader}
          <th>Reason</th>
          <th>Current stage</th>
          <th>Last activity</th>
          <th>Recommended action</th>
          <th>Sales notes</th>
          <th>Age</th>
          <th>Severity</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function recentPatientsTable(rows, opts) {
  opts = opts || {};
  const showLocation = !!opts.showLocation;
  if (!rows.length) {
    return `<div class="empty-state">No new patients submitted in this window.</div>`;
  }
  const locHeader = showLocation ? `<th>Location</th>` : '';
  const body = rows.map(r => {
    const locCell = showLocation ? `<td style="font-size:12px;">${esc(r.location || '—')}</td>` : '';
    const stageStr = r.stage && r.stage.name !== 'Unknown'
      ? `${esc(r.stage.name)}${r.stage.daysAtStage != null ? ` · <span style="color:rgba(34,29,53,0.55);">${r.stage.daysAtStage}d at stage</span>` : ''}`
      : '—';
    const activityStr = r.activity && r.activity.daysAgo != null ? `${r.activity.daysAgo}d ago` : '—';
    const salesStr = r.salesNotes
      ? `<span style="font-size:12px;">${esc(r.salesNotes)}</span>`
      : `<span style="color:rgba(34,29,53,0.35); font-size:12px;">—</span>`;
    return `
    <tr>
      <td class="pid">${esc(r.pid)}</td>
      ${locCell}
      <td class="days">${r.submittedDays}d ago</td>
      <td style="font-size:13px;">${stageStr}</td>
      <td style="font-size:12px; color:rgba(34,29,53,0.7);">${activityStr}</td>
      <td style="font-size:13px;">${esc(r.next)}</td>
      <td style="max-width:220px;">${salesStr}</td>
    </tr>
    `;
  }).join('');
  return `
    <table class="stuck-table">
      <thead>
        <tr>
          <th>Patient ID</th>
          ${locHeader}
          <th>Submitted</th>
          <th>Current stage</th>
          <th>Last activity</th>
          <th>Next step</th>
          <th>Sales notes</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function renderBillingReport(account, metrics, stuck, recent, w, prior, abandonedDays, cancelledCount) {
  const c = metrics.counts, p = metrics.period, pp = metrics.priorPeriod;
  const activationRate = pct(c.activated, c.submitted);
  const deliveryRate = pct(c.delivered, c.submitted);
  const priorLabel = prior ? prior.label : w.label;
  const funnelSub = cancelledCount
    ? `all-time (open + closed) · ${cancelledCount} cancelled excluded`
    : 'all-time (open + closed)';

  return renderShell({
    title: account.Name,
    variant: 'Billing',
    account, w, stuck, recent, abandonedDays,
    heroAccent: 'progress',
    execCards: [
      metricCard('Patients in funnel', c.submitted, funnelSub, true),
      metricCard('Activation rate', activationRate, `${c.activated} of ${c.submitted}`),
      metricCard('Devices delivered', c.delivered, deliveryRate + ' of submitted'),
    ],
    periodCards: [
      deltaCard('New submissions', p.newSubmissions, pp ? pp.newSubmissions : null, priorLabel),
      deltaCard('New activations', p.newActivations, pp ? pp.newActivations : null, priorLabel),
      deltaCard('Devices delivered', p.newDeliveries, pp ? pp.newDeliveries : null, priorLabel),
    ],
    funnelRows: [
      ['Submitted to portal', c.submitted, c.submitted],
      ['Activated', c.activated, c.submitted],
      ['Consent Hold released', c.consentReleased, c.submitted],
      ['Pre-Auth Hold released', c.preAuthReleased, c.submitted],
      ['Impression kit shipped', c.ikShipped, c.submitted],
      ['Impression kit returned', c.ikReturned, c.submitted],
      ['Impressions accepted', c.scanAccepted, c.submitted],
      ['Dentist approved', c.dentistApproved, c.submitted],
      ['Manufacturing complete', c.manufactured, c.submitted],
      ['Device delivered', c.delivered, c.submitted],
    ],
    holdsCallout: c.submitted && (c.activated - c.bothHoldsReleased) > 0
      ? `${c.activated - c.bothHoldsReleased} activated patients are waiting on one or both portal holds (Consent or Pre-Auth). See Operations below to clear them.`
      : null,
    stuck,
  });
}

function renderReferralReport(account, metrics, stuck, recent, w, prior, abandonedDays, cancelledCount) {
  const c = metrics.counts, p = metrics.period, pp = metrics.priorPeriod;
  const activationRate = pct(c.activated, c.submitted);
  const conversionRate = pct(c.converted, c.activated);
  const priorLabel = prior ? prior.label : w.label;
  const funnelSub = cancelledCount
    ? `all-time · ${cancelledCount} cancelled excluded`
    : 'all-time';

  return renderShell({
    title: account.Name,
    variant: 'Referral',
    account, w, stuck, recent, abandonedDays,
    heroAccent: 'referrals',
    execCards: [
      metricCard('Patients referred', c.submitted, funnelSub, true),
      metricCard('Activation rate', activationRate, `${c.activated} of ${c.submitted}`),
      metricCard('Conversion rate', conversionRate, `${c.converted} of ${c.activated} started treatment`),
    ],
    periodCards: [
      deltaCard('New referrals', p.newSubmissions, pp ? pp.newSubmissions : null, priorLabel),
      deltaCard('New activations', p.newActivations, pp ? pp.newActivations : null, priorLabel),
      deltaCard('New conversions', p.newConversions, pp ? pp.newConversions : null, priorLabel),
    ],
    funnelRows: [
      ['Referred', c.submitted, c.submitted],
      ['Activated', c.activated, c.submitted],
      ['Sleep test interpreted', c.sleepTestInterpreted, c.submitted],
      ['Converted (S2 purchase)', c.converted, c.submitted],
      ['Device delivered (therapy started)', c.delivered, c.submitted],
    ],
    holdsCallout: null,
    stuck,
  });
}

// Per-location breakdown table for parent rollups
function locationBreakdownTable(entries, variant) {
  const head = variant === 'Billing'
    ? ['Location', 'Active', 'New in window', 'Delivered', 'Need attention', 'Long-inactive']
    : ['Location', 'Active', 'New in window', 'Converted', 'Need attention', 'Long-inactive'];
  const rows = entries
    .slice()
    .sort((a, b) => b.contactCount - a.contactCount)
    .map(e => {
      const m = e.metrics.counts;
      const achieved = variant === 'Billing' ? m.delivered : m.converted;
      return `
        <tr>
          <td><a href="${esc(e.file)}">${esc(e.name)}</a></td>
          <td class="days">${e.contactCount}</td>
          <td class="days">${e.recentCount}</td>
          <td class="days">${achieved}</td>
          <td class="days">${e.activeStuckCount}</td>
          <td class="days" style="color:rgba(34,29,53,0.55);">${e.longInactiveCount}</td>
        </tr>
      `;
    }).join('');
  return `
    <table class="stuck-table">
      <thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderBillingRollup(synthAcc, metrics, stuck, recent, locEntries, w, prior, abandonedDays, cancelledCount) {
  const c = metrics.counts, p = metrics.period, pp = metrics.priorPeriod;
  const activationRate = pct(c.activated, c.submitted);
  const deliveryRate = pct(c.delivered, c.submitted);
  const priorLabel = prior ? prior.label : w.label;
  const funnelSub = cancelledCount
    ? `across ${locEntries.length} locations · ${cancelledCount} cancelled excluded`
    : `across ${locEntries.length} locations`;
  return renderShell({
    title: synthAcc.Name,
    variant: 'Billing',
    account: synthAcc, w, stuck, recent, abandonedDays,
    showLocation: true,
    heroAccent: 'progress',
    preFunnelExtra: `<h2>Locations &nbsp;·&nbsp; ${locEntries.length}</h2>` + locationBreakdownTable(locEntries, 'Billing'),
    execCards: [
      metricCard('Patients in funnel', c.submitted, funnelSub, true),
      metricCard('Activation rate', activationRate, `${c.activated} of ${c.submitted}`),
      metricCard('Devices delivered', c.delivered, deliveryRate + ' of submitted'),
    ],
    periodCards: [
      deltaCard('New submissions', p.newSubmissions, pp ? pp.newSubmissions : null, priorLabel),
      deltaCard('New activations', p.newActivations, pp ? pp.newActivations : null, priorLabel),
      deltaCard('Devices delivered', p.newDeliveries, pp ? pp.newDeliveries : null, priorLabel),
    ],
    funnelRows: [
      ['Submitted to portal', c.submitted, c.submitted],
      ['Activated', c.activated, c.submitted],
      ['Consent Hold released', c.consentReleased, c.submitted],
      ['Pre-Auth Hold released', c.preAuthReleased, c.submitted],
      ['Impression kit shipped', c.ikShipped, c.submitted],
      ['Impression kit returned', c.ikReturned, c.submitted],
      ['Impressions accepted', c.scanAccepted, c.submitted],
      ['Dentist approved', c.dentistApproved, c.submitted],
      ['Manufacturing complete', c.manufactured, c.submitted],
      ['Device delivered', c.delivered, c.submitted],
    ],
    holdsCallout: c.submitted && (c.activated - c.bothHoldsReleased) > 0
      ? `${c.activated - c.bothHoldsReleased} activated patients are waiting on one or both portal holds. See Operations below to clear them.`
      : null,
  });
}

function renderReferralRollup(synthAcc, metrics, stuck, recent, locEntries, w, prior, abandonedDays, cancelledCount) {
  const c = metrics.counts, p = metrics.period, pp = metrics.priorPeriod;
  const activationRate = pct(c.activated, c.submitted);
  const conversionRate = pct(c.converted, c.activated);
  const priorLabel = prior ? prior.label : w.label;
  const funnelSub = cancelledCount
    ? `across ${locEntries.length} locations · ${cancelledCount} cancelled excluded`
    : `across ${locEntries.length} locations`;
  return renderShell({
    title: synthAcc.Name,
    variant: 'Referral',
    account: synthAcc, w, stuck, recent, abandonedDays,
    showLocation: true,
    heroAccent: 'referrals',
    preFunnelExtra: `<h2>Locations &nbsp;·&nbsp; ${locEntries.length}</h2>` + locationBreakdownTable(locEntries, 'Referral'),
    execCards: [
      metricCard('Patients referred', c.submitted, funnelSub, true),
      metricCard('Activation rate', activationRate, `${c.activated} of ${c.submitted}`),
      metricCard('Conversion rate', conversionRate, `${c.converted} of ${c.activated} started treatment`),
    ],
    periodCards: [
      deltaCard('New referrals', p.newSubmissions, pp ? pp.newSubmissions : null, priorLabel),
      deltaCard('New activations', p.newActivations, pp ? pp.newActivations : null, priorLabel),
      deltaCard('New conversions', p.newConversions, pp ? pp.newConversions : null, priorLabel),
    ],
    funnelRows: [
      ['Referred', c.submitted, c.submitted],
      ['Activated', c.activated, c.submitted],
      ['Sleep test interpreted', c.sleepTestInterpreted, c.submitted],
      ['Converted (S2 purchase)', c.converted, c.submitted],
      ['Device delivered (therapy started)', c.delivered, c.submitted],
    ],
    holdsCallout: null,
  });
}

function renderShell(o) {
  const { title, variant, account, w, execCards, periodCards, funnelRows, holdsCallout, stuck, recent, heroAccent, abandonedDays, showLocation, preFunnelExtra } = o;
  const generated = new Date().toLocaleString('en-US', {
    dateStyle: 'long', timeStyle: 'short'
  });
  const accountOwner = esc(account.Owner && account.Owner.Name || '—');
  const parentName = esc(account.Parent && account.Parent.Name || '—');

  // Split stuck into active vs long-inactive by abandonedDays threshold
  const thresh = abandonedDays || Infinity;
  const activeStuck = stuck.filter(s => s.daysStuck <= thresh);
  const longInactive = stuck.filter(s => s.daysStuck > thresh);
  const recentRows = recent || [];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Daybreak Partner Report</title>
<style>${baseCss()}</style>
</head>
<body>
<div class="wrap">
  <div class="brand-bar">
    <span class="mark">${DAYBREAK_MARK_SVG}</span>
    <span>daybreak</span>
  </div>

  <section class="hero">
    <div class="meta">Partner progress report &nbsp;·&nbsp; ${esc(w.label)}</div>
    <h1>${esc(title)}<span class="variant-pill">${esc(variant)}</span></h1>
    <div class="meta" style="margin-top: 8px;">
      Your patients&rsquo; <span class="accent">${esc(heroAccent)}</span> at Daybreak
    </div>
  </section>

  <h2>Executive summary</h2>
  <div class="cards">${execCards.join('')}</div>

  <h2>In this period &nbsp;·&nbsp; ${esc(w.label)}</h2>
  <div class="cards">${periodCards.join('')}</div>

  ${preFunnelExtra || ''}

  <h2>Full funnel &nbsp;·&nbsp; all-time</h2>
  <div class="funnel">
    ${funnelRows.map(([lbl, n, tot]) => funnelRow(lbl, n, tot)).join('')}
  </div>

  ${holdsCallout ? `<div class="callout attention"><strong>Heads up:</strong> ${esc(holdsCallout)}</div>` : ''}

  <h2>Operations &nbsp;·&nbsp; awaiting activation</h2>
  ${(() => {
    const rows = activeStuck.filter(s => !s.activated);
    return `
    <p style="color:rgba(34,29,53,0.65); font-size:14px; margin: 4px 0 8px 0;">
      ${rows.length === 0
        ? 'No unactivated patients flagged.'
        : `${rows.length} patient${rows.length === 1 ? '' : 's'} submitted but not yet activated. Chase activation first — no downstream progress possible until then. Newest first.`}
    </p>
    ${stuckTable(rows, { showLocation })}
    `;
  })()}

  <h2>Recent submissions &nbsp;·&nbsp; ${esc(w.label)}</h2>
  <p style="color:rgba(34,29,53,0.65); font-size:14px; margin: 4px 0 8px 0;">
    ${recentRows.length === 0
      ? 'No new patients submitted in this window.'
      : `${recentRows.length} new patient${recentRows.length === 1 ? '' : 's'} submitted. Newest first.`}
  </p>
  ${recentPatientsTable(recentRows, { showLocation })}

  <h2>Operations &nbsp;·&nbsp; activated but stuck in workflow</h2>
  ${(() => {
    const rows = activeStuck.filter(s => s.activated);
    return `
    <p style="color:rgba(34,29,53,0.65); font-size:14px; margin: 4px 0 8px 0;">
      ${rows.length === 0
        ? 'No activated patients currently flagged.'
        : `${rows.length} activated patient${rows.length === 1 ? '' : 's'} stuck at a downstream stage. Newest first.`}
    </p>
    ${stuckTable(rows, { showLocation })}
    `;
  })()}

  ${longInactive.length ? `
    <details class="long-inactive">
      <summary>${longInactive.length} long-inactive patient${longInactive.length === 1 ? '' : 's'} &nbsp;·&nbsp; stuck &gt; ${thresh} days &nbsp;·&nbsp; click to expand</summary>
      ${stuckTable(longInactive, { showLocation })}
    </details>
  ` : ''}

  <div class="footer">
    Generated ${esc(generated)} &nbsp;·&nbsp; ${esc(parentName)} &nbsp;·&nbsp; Owner: ${accountOwner}<br>
    Confidential — for partner review only.
  </div>
</div>
</body>
</html>`;
}

function renderIndex(entries, w, userInfo) {
  const generated = new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
  const rollups = entries.filter(e => e.isRollup);
  const billing = entries.filter(e => !e.isRollup && e.variant === 'Billing');
  const referral = entries.filter(e => !e.isRollup && e.variant === 'Referral');
  const skipped = entries.filter(e => e.skipped);

  const listBlock = (title, items) => items.length === 0 ? '' : `
    <h2>${esc(title)} &nbsp;·&nbsp; ${items.length}</h2>
    <ul class="index-list">
      ${items.map(e => `
        <li>
          <a href="${esc(e.file)}">${esc(e.name)}</a>
          <span class="meta">${e.recentCount || 0} new &nbsp;·&nbsp; ${e.activeStuckCount} need attention${e.longInactiveCount ? ' · ' + e.longInactiveCount + ' long-inactive' : ''} &nbsp;·&nbsp; ${e.contactCount} patients</span>
        </li>
      `).join('')}
    </ul>
  `;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Partner Reports — ${esc(w.label)}</title>
<style>${baseCss()}
  .index-list { list-style: none; padding: 0; margin: 0; }
  .index-list li {
    padding: 14px 0; border-bottom: 1px solid rgba(34,29,53,0.08);
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
  }
  .index-list a {
    color: var(--deepsleep); text-decoration: none; font-weight: 600; font-size: 16px;
  }
  .index-list a:hover { text-decoration: underline; }
  .index-list .meta {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em;
    color: rgba(34,29,53,0.55); white-space: nowrap;
  }
  .index-skipped {
    margin-top: 16px; padding: 16px; background: var(--linen); border-radius: 8px;
    font-size: 13px;
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand-bar"><span class="mark">${DAYBREAK_MARK_SVG}</span><span>daybreak</span></div>

  <section class="hero">
    <div class="meta">Partner reports index</div>
    <h1>Reports for <span class="accent">${esc(w.label)}</span></h1>
    <div class="meta" style="margin-top:8px;">Owner: ${esc(userInfo.name || userInfo.username)}</div>
  </section>

  ${listBlock('Organization rollups', rollups)}
  ${listBlock('Billing partners', billing)}
  ${listBlock('Referral partners', referral)}

  ${skipped.length ? `
    <div class="index-skipped">
      <strong>Skipped (${skipped.length}):</strong>
      <ul>
        ${skipped.map(e => `<li>${esc(e.name)} — ${esc(e.reason)}</li>`).join('')}
      </ul>
    </div>` : ''}

  <div class="footer">
    Generated ${esc(generated)} &nbsp;·&nbsp; Confidential — for internal review
  </div>
</div>
</body>
</html>`;
}

// ===== Main =====

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function main() {
  const args = parseArgs(process.argv);
  const w = parseWindow(args.window);
  const prior = args.compare ? priorPeriod(w) : null;
  const now = new Date();

  console.error(`[partner-report] window: ${w.label} (${fmtDate(w.start)} → ${fmtDate(w.end)})`);
  if (prior) console.error(`[partner-report] comparing vs: ${prior.label} (${fmtDate(prior.start)} → ${fmtDate(prior.end)})`);
  console.error(`[partner-report] abandoned threshold: ${args.abandonedDays} days`);

  const user = currentUser();
  console.error(`[partner-report] user: ${user.username} (${user.id})`);

  const accounts = queryLocationAccounts(user.id, args.accounts);
  console.error(`[partner-report] ${accounts.length} Location accounts owned by user`);

  if (!accounts.length) {
    console.error('[partner-report] no accounts — nothing to do');
    process.exit(0);
  }

  // Fetch all contacts for all accounts in one query
  const allContacts = queryContactsForAccounts(accounts.map(a => a.Id));
  console.error(`[partner-report] ${allContacts.length} contacts across all accounts`);

  // Tag each contact with its owning account's name so rollups can show Location column.
  const accIdToName = new Map(accounts.map(a => [a.Id, a.Name]));
  for (const c of allContacts) c._accountName = accIdToName.get(c.AccountId) || '—';

  const byAccount = new Map();
  for (const c of allContacts) {
    const arr = byAccount.get(c.AccountId) || [];
    arr.push(c);
    byAccount.set(c.AccountId, arr);
  }

  const outDir = args.out || path.join(process.cwd(), 'output', 'partner-reports', fmtDate(now));
  if (!args.dryRun) ensureDir(outDir);

  // Billing Model routing:
  //   'Billing Model' and 'MD Model' → Billing variant (both bill for the device themselves)
  //   'Refer Model'                  → Referral variant (D2C handled by Daybreak)
  const BILLING_MODELS = new Set(['Billing Model', 'MD Model']);
  const REFERRAL_MODELS = new Set(['Refer Model']);

  const entries = [];
  for (const acc of accounts) {
    const model = acc.Parent && acc.Parent.Billing_Model__c;
    const name = acc.Name;
    const contacts = byAccount.get(acc.Id) || [];

    if (!model) {
      entries.push({ name, skipped: true, reason: 'Parent Billing Model is null' });
      console.error(`[partner-report] SKIP ${name}: no Billing Model on parent`);
      continue;
    }

    let variant;
    if (BILLING_MODELS.has(model)) variant = 'Billing';
    else if (REFERRAL_MODELS.has(model)) variant = 'Referral';
    else {
      entries.push({ name, skipped: true, reason: `Unknown Billing Model: ${model}` });
      console.error(`[partner-report] SKIP ${name}: unknown Billing Model '${model}'`);
      continue;
    }

    // Filter contacts by Record Type:
    //   Billing  → 'Customer - PRO' only
    //   Referral → 'Customer - DTC' only
    //   Providers and any other Record Types are excluded — not patients.
    const typeFiltered = filterContactsForVariant(contacts, variant);
    const excluded = contacts.length - typeFiltered.length;

    // Remove cancelled patients from all funnel metrics and stuck lists.
    // Cancelled count is displayed separately in the report header.
    const cancelledContacts = typeFiltered.filter(isCancelled);
    const activeContacts = typeFiltered.filter(c => !isCancelled(c));
    const cancelledCount = cancelledContacts.length;

    let metrics, stuck, recent, html;
    if (variant === 'Billing') {
      metrics = billingMetrics(activeContacts, w, prior);
      stuck = stuckBilling(activeContacts, now);
      recent = recentPatients(activeContacts, w, 'Billing', now);
      html = renderBillingReport(acc, metrics, stuck, recent, w, prior, args.abandonedDays, cancelledCount);
    } else {
      metrics = referralMetrics(activeContacts, w, prior);
      stuck = stuckReferral(activeContacts, now);
      recent = recentPatients(activeContacts, w, 'Referral', now);
      html = renderReferralReport(acc, metrics, stuck, recent, w, prior, args.abandonedDays, cancelledCount);
    }

    const filename = `${slug(name)}-${variant.toLowerCase()}.html`;
    const filepath = path.join(outDir, filename);
    if (!args.dryRun) fs.writeFileSync(filepath, html, 'utf8');

    const activeStuck = stuck.filter(s => s.daysStuck <= args.abandonedDays).length;
    const longInactive = stuck.filter(s => s.daysStuck > args.abandonedDays).length;
    entries.push({
      name, variant, file: filename, path: filepath,
      account: acc,
      activeContacts, cancelledCount,
      metrics, stuck, recent,
      contactCount: activeContacts.length,
      excludedCount: excluded,
      stuckCount: stuck.length,
      activeStuckCount: activeStuck,
      longInactiveCount: longInactive,
      recentCount: recent.length,
    });
    console.error(`[partner-report] ${variant.padEnd(8)} ${name} → ${filename} (${activeContacts.length} active pts${cancelledCount ? ', ' + cancelledCount + ' cancelled' : ''}${excluded ? ', ' + excluded + ' wrong type' : ''}, ${recent.length} new, ${activeStuck} need attention${longInactive ? ', ' + longInactive + ' long-inactive' : ''})`);
  }

  // ===== Parent-level rollups =====
  // For any parent account with >= 2 built Location reports, emit a single rollup
  // aggregating all locations (exec summary, funnel, cross-location recent + stuck).
  const byParent = new Map();
  for (const e of entries) {
    if (e.skipped) continue;
    const pid = e.account.ParentId;
    if (!pid) continue;
    const arr = byParent.get(pid) || [];
    arr.push(e);
    byParent.set(pid, arr);
  }
  const rollupEntries = [];
  for (const [pid, es] of byParent) {
    if (es.length < 2) continue;
    const parentName = es[0].account.Parent && es[0].account.Parent.Name || 'Parent';
    const variant = es[0].variant;
    // Aggregate active contacts across all child locations
    const allActive = es.flatMap(e => e.activeContacts);
    const allStuck = es.flatMap(e => e.stuck);
    const allRecent = recentPatients(allActive, w, variant, now);
    const metrics = variant === 'Billing'
      ? billingMetrics(allActive, w, prior)
      : referralMetrics(allActive, w, prior);
    const cancelledCount = es.reduce((s, e) => s + (e.cancelledCount || 0), 0);
    // Build synthetic "account" for renderShell
    const synthAcc = {
      Name: `${parentName} — All Locations`,
      Owner: es[0].account.Owner,
      Parent: { Name: `${parentName} (${es.length} locations)` },
    };
    const html = variant === 'Billing'
      ? renderBillingRollup(synthAcc, metrics, allStuck, allRecent, es, w, prior, args.abandonedDays, cancelledCount)
      : renderReferralRollup(synthAcc, metrics, allStuck, allRecent, es, w, prior, args.abandonedDays, cancelledCount);
    const filename = `_rollup-${slug(parentName)}-${variant.toLowerCase()}.html`;
    const filepath = path.join(outDir, filename);
    if (!args.dryRun) fs.writeFileSync(filepath, html, 'utf8');
    rollupEntries.push({
      name: `${parentName} — All ${es.length} locations`,
      variant, file: filename, path: filepath,
      isRollup: true,
      contactCount: allActive.length,
      activeStuckCount: allStuck.filter(s => s.daysStuck <= args.abandonedDays).length,
      longInactiveCount: allStuck.filter(s => s.daysStuck > args.abandonedDays).length,
      recentCount: allRecent.length,
    });
    console.error(`[partner-report] ROLLUP   ${parentName} (${es.length} locs) → ${filename} (${allActive.length} active, ${allRecent.length} new, ${allStuck.length} stuck)`);
  }
  // Rollups are displayed first in the index
  const indexEntries = [...rollupEntries, ...entries];

  // Index page
  const indexPath = path.join(outDir, 'index.html');
  if (!args.dryRun) {
    const indexHtml = renderIndex(indexEntries, w, { name: user.username, username: user.username });
    fs.writeFileSync(indexPath, indexHtml, 'utf8');
  }

  // Summary
  const built = entries.filter(e => !e.skipped);
  const skipped = entries.filter(e => e.skipped);
  console.log(JSON.stringify({
    window: w.label,
    output_dir: outDir,
    index: indexPath,
    accounts_total: accounts.length,
    reports_built: built.length,
    rollups_built: rollupEntries.length,
    billing: built.filter(e => e.variant === 'Billing').length,
    referral: built.filter(e => e.variant === 'Referral').length,
    skipped: skipped.length,
    skipped_detail: skipped,
    dry_run: args.dryRun,
  }, null, 2));
}

try {
  main();
} catch (e) {
  console.error(`[partner-report] ERROR: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
