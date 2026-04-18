#!/usr/bin/env node
/**
 * Internal Daily Dashboard — Daybreak team-facing
 * Single self-contained HTML with client-side tabs, filters, sliders.
 * Full patient names link to Salesforce Contact records.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ===== Editable defaults =====

const MONTHLY_GOALS_DEFAULT = {
  submissions: 0,
  activations: 0,
  conversions: 0,
  deliveries: 0,
};

const SF_INSTANCE_URL = 'https://daybreak.my.salesforce.com';

const BRAND = {
  sunlight: '#FECF00',
  deepSleep: '#221D35',
  pillow: '#FFFFFF',
  sky: '#DDE4ED',
  linen: '#F6ECE1',
  muted: '#6B6778',
  border: '#E5E1E9',
  success: '#2d7a4f',
  danger: '#9c3a2c',
};

// Stuck thresholds (days)
const STUCK = {
  notActivated: 1,
  epworthIncomplete: 3,
  holdNotReleased: 7,
  noRx: 7,
  noConversion: 14,
};

// ===== CLI =====

function parseArgs(argv) {
  const args = {
    accounts: null,
    out: null,
    dryRun: false,
    goals: { ...MONTHLY_GOALS_DEFAULT },
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--accounts') args.accounts = argv[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--goal-submissions') args.goals.submissions = parseInt(argv[++i], 10) || 0;
    else if (a === '--goal-activations') args.goals.activations = parseInt(argv[++i], 10) || 0;
    else if (a === '--goal-conversions') args.goals.conversions = parseInt(argv[++i], 10) || 0;
    else if (a === '--goal-deliveries') args.goals.deliveries = parseInt(argv[++i], 10) || 0;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node runner.js [options]
  --accounts <ids>          Comma-separated Location Account IDs (default: owned by user)
  --out <path>              Output HTML path (default: output/internal-dashboard/dashboard.html)
  --goal-submissions <n>    Monthly submission goal (default 0 = no goal bar)
  --goal-activations <n>    Monthly activation goal
  --goal-conversions <n>    Monthly conversion goal (referral only)
  --goal-deliveries <n>     Monthly delivery goal
  --dry-run                 Query + log counts, skip writing HTML`);
}

// ===== Salesforce =====

const SF_OPTS = { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, shell: true };

function sfQuery(soql) {
  const tmp = path.join(os.tmpdir(), `id-q-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmp, soql, 'utf8');
  try {
    const out = execFileSync('sf', ['data', 'query', '--result-format', 'json', '--file', `"${tmp}"`], SF_OPTS);
    const parsed = JSON.parse(out);
    if (parsed.status !== 0) throw new Error(`sf query failed: ${JSON.stringify(parsed)}`);
    return parsed.result.records || [];
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

function currentUser() {
  const out = execFileSync('sf', ['org', 'display', 'user', '--json'], SF_OPTS);
  const parsed = JSON.parse(out);
  if (parsed.status !== 0) throw new Error('sf org display user failed');
  return parsed.result;
}

function queryLocationAccounts(userId, accountIds) {
  let where;
  if (accountIds && accountIds.length) {
    const ids = accountIds.map(id => `'${id}'`).join(', ');
    where = `RecordType.Name = 'Location' AND Id IN (${ids})`;
  } else {
    where = `RecordType.Name = 'Location' AND OwnerId = '${userId}'`;
  }
  return sfQuery(`
    SELECT Id, Name, OwnerId, Owner.Name, ParentId, Parent.Name, Parent.Billing_Model__c
    FROM Account
    WHERE ${where}
    ORDER BY Name
  `.trim());
}

function querySleepSystemsByContact(contactIds) {
  if (!contactIds.length) return new Map();
  const byContact = new Map();
  const chunkSize = 100;
  for (let i = 0; i < contactIds.length; i += chunkSize) {
    const ids = contactIds.slice(i, i + chunkSize).map(id => `'${id}'`).join(',');
    const rows = sfQuery(`
      SELECT Contact__c, Amount_Net_Total__c, Amount_Self_Paid__c, Amount_Insurance_Paid__c, CreatedDate
      FROM Sleep_System__c
      WHERE Contact__c IN (${ids})
    `.trim());
    for (const r of rows) {
      const prev = byContact.get(r.Contact__c) || { netPaid: 0, selfPaid: 0, insurancePaid: 0, count: 0 };
      prev.netPaid += r.Amount_Net_Total__c || 0;
      prev.selfPaid += r.Amount_Self_Paid__c || 0;
      prev.insurancePaid += r.Amount_Insurance_Paid__c || 0;
      prev.count += 1;
      byContact.set(r.Contact__c, prev);
    }
  }
  return byContact;
}

function queryContacts(accountIds) {
  if (!accountIds.length) return [];
  const all = [];
  const chunkSize = 100;
  const fields = [
    'Id', 'AccountId', 'RecordType.Name',
    'FirstName', 'LastName', 'Birthdate', 'Email', 'Phone',
    'Patient_ID__c', 'Referral_MRN__c',
    'CreatedDate',
    'Cancelled_Date__c',
    'Auth0_Registration_Date__c',
    'Health_Questionnaire__c',
    'Dental_Form_Completed_Timestamp__c',
    'IK_Shipped_Date__c', 'IK_Return_Delivered_Date__c',
    'Scan_Accepted_Date__c', 'Dentist_Review_Completed_Date__c',
    'Patient_Consent_Hold_Released__c',
    'Patient_Consent_Hold_Released_Date__c',
    'Pre_Authorization_Hold_Released__c',
    'MAD_Manufacturing_Completed_Date__c',
    'MAD_Shipped_Date__c',
    'MAD_Delivered_Date__c',
    'Sleep_Test_Interpreted_Date__c',
    'Most_Recent_Patient_RX__c',
    'S2_Purchase_Date__c',
    'Sales_Notes__c',
  ].join(', ');
  for (let i = 0; i < accountIds.length; i += chunkSize) {
    const ids = accountIds.slice(i, i + chunkSize).map(id => `'${id}'`).join(',');
    const rows = sfQuery(`SELECT ${fields} FROM Contact WHERE AccountId IN (${ids})`);
    all.push(...rows);
  }
  return all;
}

// ===== Date helpers =====

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function daysSince(dateStr, now) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Math.floor((now - d) / DAY);
}
function fmtDate(d) { return d.toISOString().slice(0, 10); }
function fmtDateTime(d) {
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function inRange(dateStr, start, endExclusive) {
  if (!dateStr) return false;
  const t = new Date(dateStr).getTime();
  return t >= start.getTime() && t < endExclusive.getTime();
}

// ===== Metrics helpers =====

function has(c, field) {
  const v = c[field];
  return v !== null && v !== undefined && v !== '' && v !== false;
}

function isCancelled(c) { return has(c, 'Cancelled_Date__c'); }

// Stage sequences
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
  let cur = { name: 'Unknown', date: null };
  for (const s of stages) {
    if (has(c, s.field)) cur = { name: s.name, date: c[s.field] };
  }
  return { ...cur, daysAtStage: daysSince(cur.date, now) };
}

function nextStep(c, variant) {
  if (has(c, 'MAD_Delivered_Date__c')) return { text: 'Complete — in therapy', owner: 'done' };
  const activated = has(c, 'Auth0_Registration_Date__c');
  if (variant === 'Billing') {
    if (!activated)                                      return { text: 'Complete activation', owner: 'patient' };
    if (!has(c, 'Health_Questionnaire__c'))              return { text: 'Complete Epworth', owner: 'patient' };
    if (c.Patient_Consent_Hold_Released__c !== true)     return { text: 'Release Consent Hold', owner: 'partner' };
    if (c.Pre_Authorization_Hold_Released__c !== true)   return { text: 'Release Pre-Auth Hold', owner: 'partner' };
    if (!has(c, 'IK_Shipped_Date__c'))                   return { text: 'Ship impression kit', owner: 'daybreak' };
    if (!has(c, 'IK_Return_Delivered_Date__c'))          return { text: 'Return impression kit', owner: 'patient' };
    if (!has(c, 'Scan_Accepted_Date__c'))                return { text: 'Accept impressions', owner: 'daybreak' };
    if (!has(c, 'Dentist_Review_Completed_Date__c'))     return { text: 'Dentist review', owner: 'dentist' };
    if (!has(c, 'MAD_Manufacturing_Completed_Date__c'))  return { text: 'Manufacture device', owner: 'daybreak' };
    return { text: 'Deliver device', owner: 'daybreak' };
  }
  if (!activated)                                  return { text: 'Complete activation', owner: 'patient' };
  if (!has(c, 'Most_Recent_Patient_RX__c'))        return { text: 'Write Rx', owner: 'clinical' };
  if (!has(c, 'S2_Purchase_Date__c'))              return { text: 'S2 conversion', owner: 's2-sales' };
  return { text: 'Deliver device', owner: 'daybreak' };
}

const ACTIVITY_FIELDS = [
  'CreatedDate', 'Auth0_Registration_Date__c', 'Dental_Form_Completed_Timestamp__c',
  'IK_Shipped_Date__c', 'IK_Return_Delivered_Date__c', 'Scan_Accepted_Date__c',
  'Dentist_Review_Completed_Date__c', 'MAD_Manufacturing_Completed_Date__c',
  'MAD_Delivered_Date__c', 'Sleep_Test_Interpreted_Date__c',
  'S2_Purchase_Date__c', 'Patient_Consent_Hold_Released_Date__c',
];
function lastActivity(c, now) {
  let latest = null;
  for (const f of ACTIVITY_FIELDS) {
    if (has(c, f)) {
      const d = new Date(c[f]);
      if (!latest || d > latest) latest = d;
    }
  }
  return { date: latest ? latest.toISOString() : null, daysAgo: latest ? daysSince(latest, now) : null };
}

function stuckBucket(c, variant, now) {
  if (has(c, 'MAD_Delivered_Date__c')) return null;
  const submittedDays = daysSince(c.CreatedDate, now);
  const activatedDays = daysSince(c.Auth0_Registration_Date__c, now);

  if (!has(c, 'Auth0_Registration_Date__c')) {
    if (submittedDays !== null && submittedDays > STUCK.notActivated) {
      return {
        bucket: 'awaiting_activation',
        severity: submittedDays > 14 ? 'high' : submittedDays > 7 ? 'medium' : 'low',
        daysStuck: submittedDays,
      };
    }
    return null;
  }

  if (variant === 'Billing') {
    if (c.Patient_Consent_Hold_Released__c !== true && activatedDays > STUCK.holdNotReleased) {
      return { bucket: 'consent_hold', severity: 'high', daysStuck: activatedDays };
    }
    if (c.Pre_Authorization_Hold_Released__c !== true && activatedDays > STUCK.holdNotReleased) {
      return { bucket: 'preauth_hold', severity: 'high', daysStuck: activatedDays };
    }
    if (!has(c, 'Health_Questionnaire__c') && activatedDays > STUCK.epworthIncomplete) {
      return { bucket: 'epworth', severity: 'low', daysStuck: activatedDays };
    }
    if (has(c, 'IK_Shipped_Date__c') && !has(c, 'IK_Return_Delivered_Date__c')) {
      const shippedDays = daysSince(c.IK_Shipped_Date__c, now);
      if (shippedDays > 14) return { bucket: 'ik_not_returned', severity: shippedDays > 30 ? 'high' : 'medium', daysStuck: shippedDays };
    }
  } else {
    if (!has(c, 'Most_Recent_Patient_RX__c') && activatedDays > STUCK.noRx) {
      return { bucket: 'no_rx', severity: activatedDays > 14 ? 'high' : 'medium', daysStuck: activatedDays };
    }
    if (has(c, 'Most_Recent_Patient_RX__c') && !has(c, 'S2_Purchase_Date__c') && activatedDays > STUCK.noConversion) {
      return { bucket: 'no_conversion', severity: activatedDays > 30 ? 'high' : 'medium', daysStuck: activatedDays };
    }
  }
  return null;
}

// ===== Main =====

function main() {
  const args = parseArgs(process.argv);
  const now = new Date();
  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + DAY);
  const yesterday = new Date(today.getTime() - DAY);
  const sevenDaysAgo = new Date(today.getTime() - 7 * DAY);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * DAY);
  const ninetyDaysAgo = new Date(today.getTime() - 90 * DAY);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  console.error(`[internal-dashboard] running ${fmtDate(now)}`);
  const user = currentUser();
  console.error(`[internal-dashboard] user: ${user.username}`);

  const accounts = queryLocationAccounts(user.id, args.accounts);
  console.error(`[internal-dashboard] ${accounts.length} Location accounts`);
  if (!accounts.length) { console.error('[internal-dashboard] no accounts — nothing to do'); process.exit(0); }

  const contacts = queryContacts(accounts.map(a => a.Id));
  console.error(`[internal-dashboard] ${contacts.length} contacts total`);

  const sleepByContact = querySleepSystemsByContact(contacts.map(c => c.Id));
  console.error(`[internal-dashboard] ${sleepByContact.size} contacts have Sleep_System rows`);

  // Build patient records (unified, with everything the UI may need)
  const accById = new Map(accounts.map(a => [a.Id, a]));
  const patients = [];
  let cancelledCount = 0, wrongTypeCount = 0;

  for (const c of contacts) {
    const acc = accById.get(c.AccountId);
    if (!acc) continue;
    const model = acc.Parent && acc.Parent.Billing_Model__c;
    let variant;
    if (model === 'Billing Model' || model === 'MD Model') variant = 'Billing';
    else if (model === 'Refer Model') variant = 'Referral';
    else continue; // unknown model -> skip

    // Record-type filter: Billing→Customer-PRO, Referral→Customer-DTC
    const wantRT = variant === 'Billing' ? 'Customer - PRO' : 'Customer - DTC';
    if (!c.RecordType || c.RecordType.Name !== wantRT) { wrongTypeCount++; continue; }

    if (isCancelled(c)) { cancelledCount++; continue; }

    const stages = variant === 'Billing' ? BILLING_STAGES : REFERRAL_STAGES;
    const stage = currentStage(c, stages, now);
    const activity = lastActivity(c, now);
    const next = nextStep(c, variant);
    const stuck = stuckBucket(c, variant, now);
    const fullName = [c.FirstName, c.LastName].filter(Boolean).join(' ') || '—';
    const sleep = sleepByContact.get(c.Id) || null;

    patients.push({
      id: c.Id,
      sfUrl: `${SF_INSTANCE_URL}/${c.Id}`,
      name: fullName,
      patientId: c.Patient_ID__c || c.Referral_MRN__c || null,
      email: c.Email || null,
      phone: c.Phone || null,
      birthdate: c.Birthdate || null,
      accountId: acc.Id,
      accountName: acc.Name,
      parentName: (acc.Parent && acc.Parent.Name) || '—',
      ownerName: (acc.Owner && acc.Owner.Name) || '—',
      variant,
      stageName: stage.name,
      stageDate: stage.date,
      daysAtStage: stage.daysAtStage,
      lastActivity: activity.date,
      daysSinceActivity: activity.daysAgo,
      nextStep: next.text,
      nextOwner: next.owner,
      salesNotes: c.Sales_Notes__c || null,
      submitted: c.CreatedDate || null,
      activated: c.Auth0_Registration_Date__c || null,
      delivered: c.MAD_Delivered_Date__c || null,
      converted: c.S2_Purchase_Date__c || null,
      rx: c.Most_Recent_Patient_RX__c || null,
      consentReleased: c.Patient_Consent_Hold_Released__c === true,
      preauthReleased: c.Pre_Authorization_Hold_Released__c === true,
      ikShipped: c.IK_Shipped_Date__c || null,
      ikReturned: c.IK_Return_Delivered_Date__c || null,
      stuckBucket: stuck ? stuck.bucket : null,
      stuckSeverity: stuck ? stuck.severity : null,
      daysStuck: stuck ? stuck.daysStuck : null,
      daysSinceSubmitted: daysSince(c.CreatedDate, now),
      daysSinceActivated: daysSince(c.Auth0_Registration_Date__c, now),
      netPaid: sleep ? Math.round(sleep.netPaid * 100) / 100 : null,
      selfPaid: sleep ? Math.round(sleep.selfPaid * 100) / 100 : null,
      insurancePaid: sleep ? Math.round(sleep.insurancePaid * 100) / 100 : null,
      sleepSystemCount: sleep ? sleep.count : 0,
    });
  }

  console.error(`[internal-dashboard] ${patients.length} active patients (${cancelledCount} cancelled, ${wrongTypeCount} wrong record-type excluded)`);

  // ===== KPIs (computed per scope: master, billing, referral) =====
  function computeKpi(ps) {
    const countIn = (field, from, toExcl) =>
      ps.filter(p => p[field] && inRange(p[field], from, toExcl)).length;
    const sumIn = (valField, dateField, from, toExcl) =>
      ps.filter(p => p[dateField] && inRange(p[dateField], from, toExcl))
        .reduce((s, p) => s + (p[valField] || 0), 0);
    return {
      submissions: {
        today: countIn('submitted', today, tomorrow),
        yesterday: countIn('submitted', yesterday, today),
        last7: countIn('submitted', sevenDaysAgo, tomorrow),
        mtd: countIn('submitted', monthStart, tomorrow),
        goal: args.goals.submissions,
      },
      activations: {
        today: countIn('activated', today, tomorrow),
        yesterday: countIn('activated', yesterday, today),
        last7: countIn('activated', sevenDaysAgo, tomorrow),
        mtd: countIn('activated', monthStart, tomorrow),
        goal: args.goals.activations,
      },
      conversions: {
        today: countIn('converted', today, tomorrow),
        yesterday: countIn('converted', yesterday, today),
        last7: countIn('converted', sevenDaysAgo, tomorrow),
        mtd: countIn('converted', monthStart, tomorrow),
        goal: args.goals.conversions,
        // Dollar value sums by conversion date
        netPaidToday: sumIn('netPaid', 'converted', today, tomorrow),
        netPaidYesterday: sumIn('netPaid', 'converted', yesterday, today),
        netPaidLast7: sumIn('netPaid', 'converted', sevenDaysAgo, tomorrow),
        netPaidMtd: sumIn('netPaid', 'converted', monthStart, tomorrow),
      },
      deliveries: {
        today: countIn('delivered', today, tomorrow),
        yesterday: countIn('delivered', yesterday, today),
        last7: countIn('delivered', sevenDaysAgo, tomorrow),
        mtd: countIn('delivered', monthStart, tomorrow),
        goal: args.goals.deliveries,
      },
    };
  }
  const billingPatients = patients.filter(p => p.variant === 'Billing');
  const referralPatients = patients.filter(p => p.variant === 'Referral');
  const kpi = {
    master: computeKpi(patients),
    billing: computeKpi(billingPatients),
    referral: computeKpi(referralPatients),
  };

  // ===== Alerts (per scope) =====
  function computeAlerts(ps, scope) {
    const a = [];
    const fresh = ps.filter(p => p.stuckBucket === 'awaiting_activation' && p.daysStuck <= 3);
    if (fresh.length) a.push({ level: 'warn',
      title: `${fresh.length} fresh unactivated patient${fresh.length === 1 ? '' : 's'}`,
      detail: 'Submitted in last 1–3 days, haven\'t activated yet. Chase today while momentum is fresh.',
      tab: 'action' });
    const holds = ps.filter(p => (p.stuckBucket === 'consent_hold' || p.stuckBucket === 'preauth_hold') && p.daysStuck >= 14);
    if (holds.length) a.push({ level: 'danger',
      title: `${holds.length} hold${holds.length === 1 ? '' : 's'} aging past 14 days`,
      detail: 'Activated patients waiting on Consent or Pre-Auth release. Escalate with partner.',
      tab: 'action' });
    const rxOver = ps.filter(p => p.stuckBucket === 'no_rx' && p.daysStuck >= 14);
    if (rxOver.length) a.push({ level: 'danger',
      title: `${rxOver.length} referral patient${rxOver.length === 1 ? '' : 's'} waiting >14d for Rx`,
      detail: 'Clinical team needs to advance Rx workflow.',
      tab: 'action' });
    const convLag = ps.filter(p => p.stuckBucket === 'no_conversion' && p.daysStuck >= 21);
    if (convLag.length) a.push({ level: 'warn',
      title: `${convLag.length} patient${convLag.length === 1 ? '' : 's'} with Rx >21d, no S2 conversion`,
      detail: 'S2 sales follow-up — these are getting cold.',
      tab: 'action' });
    return a;
  }
  const alerts = {
    master: computeAlerts(patients, 'master'),
    billing: computeAlerts(billingPatients, 'billing'),
    referral: computeAlerts(referralPatients, 'referral'),
  };

  // ===== Account summary =====
  const accSummary = accounts.map(a => {
    const list = patients.filter(p => p.accountId === a.Id);
    return {
      id: a.Id,
      name: a.Name,
      parent: (a.Parent && a.Parent.Name) || '—',
      owner: (a.Owner && a.Owner.Name) || '—',
      variant: (a.Parent && a.Parent.Billing_Model__c === 'Refer Model') ? 'Referral' : 'Billing',
      active: list.length,
      submittedLast7: list.filter(p => p.submitted && inRange(p.submitted, sevenDaysAgo, tomorrow)).length,
      submittedMTD: list.filter(p => p.submitted && inRange(p.submitted, monthStart, tomorrow)).length,
      deliveredMTD: list.filter(p => p.delivered && inRange(p.delivered, monthStart, tomorrow)).length,
      convertedMTD: list.filter(p => p.converted && inRange(p.converted, monthStart, tomorrow)).length,
      stuck: list.filter(p => p.stuckBucket).length,
      awaitingActivation: list.filter(p => p.stuckBucket === 'awaiting_activation').length,
    };
  });

  // ===== Recent activity feed =====
  const events = [];
  const pushEvent = (p, type, dateField, label) => {
    if (p[dateField] && inRange(p[dateField], thirtyDaysAgo, tomorrow)) {
      events.push({
        type, label, date: p[dateField],
        patientId: p.id, name: p.name, sfUrl: p.sfUrl,
        accountName: p.accountName, variant: p.variant,
      });
    }
  };
  for (const p of patients) {
    pushEvent(p, 'submitted', 'submitted', p.variant === 'Billing' ? 'Submitted' : 'Referred');
    pushEvent(p, 'activated', 'activated', 'Activated');
    pushEvent(p, 'converted', 'converted', 'Converted (S2)');
    pushEvent(p, 'delivered', 'delivered', 'Delivered');
  }
  events.sort((a, b) => new Date(b.date) - new Date(a.date));

  // Patients sorted newest-submitted first across the board
  patients.sort((a, b) => new Date(b.submitted || 0) - new Date(a.submitted || 0));

  // ===== Output =====
  const outPath = args.out || path.resolve(process.cwd(), 'output', 'internal-dashboard', 'dashboard.html');
  if (!args.dryRun) fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const statsFor = ps => ({
    active: ps.length,
    stuck: ps.filter(p => p.stuckBucket).length,
    awaitingActivation: ps.filter(p => p.stuckBucket === 'awaiting_activation').length,
  });
  const payload = {
    generatedAt: now.toISOString(),
    user: { name: user.username, id: user.id },
    goals: args.goals,
    kpi, alerts, accSummary, events, patients,
    totals: {
      master: { accounts: accounts.length, ...statsFor(patients),
                cancelledExcluded: cancelledCount, wrongTypeExcluded: wrongTypeCount },
      billing:  { accounts: accSummary.filter(a => a.variant === 'Billing').length,  ...statsFor(billingPatients) },
      referral: { accounts: accSummary.filter(a => a.variant === 'Referral').length, ...statsFor(referralPatients) },
    },
  };

  if (args.dryRun) {
    console.log(JSON.stringify({ ...payload, patients: `[${patients.length} records]`, events: `[${events.length} events]` }, null, 2));
    return;
  }

  const html = renderHtml(payload);
  fs.writeFileSync(outPath, html, 'utf8');
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.error(`[internal-dashboard] wrote ${outPath} (${kb} KB)`);
  console.log(JSON.stringify({
    output: outPath,
    active_patients: patients.length,
    billing: payload.totals.billing.active,
    referral: payload.totals.referral.active,
    accounts: accounts.length,
    alerts_master: alerts.master.length,
    stuck: payload.totals.master.stuck,
  }, null, 2));
}

// ===== HTML template =====

function renderHtml(payload) {
  const css = baseCss();
  const js = clientJs();
  const dataScript = `window.__DASHBOARD__ = ${JSON.stringify(payload).replace(/</g, '\\u003c')};`;
  const generatedHuman = new Date(payload.generatedAt).toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daybreak — Internal Dashboard</title>
<style>${css}</style>
</head>
<body>
<header class="top">
  <div class="top-inner">
    <div>
      <h1>daybreak <em>morning briefing</em></h1>
      <div class="subtitle">Internal dashboard — ${escapeHtml(generatedHuman)}</div>
    </div>
    <div class="top-stats" id="topStats"></div>
  </div>
</header>

<nav class="section-nav">
  <button class="section-btn active" data-section="master">Master <span class="section-count">${payload.totals.master.active}</span></button>
  <button class="section-btn" data-section="billing">Billing <span class="section-count">${payload.totals.billing.active}</span></button>
  <button class="section-btn" data-section="referral">Referral <span class="section-count">${payload.totals.referral.active}</span></button>
</nav>

<nav class="tabs">
  <button class="tab-btn active" data-tab="briefing">Morning briefing</button>
  <button class="tab-btn" data-tab="action">Action queue</button>
  <button class="tab-btn" data-tab="recent">Recent activity</button>
  <button class="tab-btn" data-tab="accounts">Accounts</button>
  <button class="tab-btn" data-tab="patients">All patients</button>
  <button class="tab-btn only-billing" data-tab="ordered" style="display:none;">Ordered vs Unordered</button>
  <button class="tab-btn only-referral" data-tab="salesnotes" style="display:none;">Sales notes outreach</button>
</nav>

<main>
  <section class="tab-panel active" id="tab-briefing"></section>
  <section class="tab-panel" id="tab-action"></section>
  <section class="tab-panel" id="tab-recent"></section>
  <section class="tab-panel" id="tab-accounts"></section>
  <section class="tab-panel" id="tab-patients"></section>
  <section class="tab-panel" id="tab-ordered"></section>
  <section class="tab-panel" id="tab-salesnotes"></section>
</main>

<script>${dataScript}</script>
<script>${js}</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function baseCss() {
  return `
:root {
  --sunlight: ${BRAND.sunlight};
  --deepsleep: ${BRAND.deepSleep};
  --pillow: ${BRAND.pillow};
  --sky: ${BRAND.sky};
  --linen: ${BRAND.linen};
  --muted: ${BRAND.muted};
  --border: ${BRAND.border};
  --success: ${BRAND.success};
  --danger: ${BRAND.danger};
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--pillow); color: var(--deepsleep); }
body {
  font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 13px; line-height: 1.45;
}
header.top { background: var(--deepsleep); color: var(--pillow); padding: 20px 28px; }
.top-inner { display: flex; justify-content: space-between; align-items: flex-end; gap: 32px; flex-wrap: wrap; max-width: 1600px; margin: 0 auto; }
header.top h1 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: 0.2px; }
header.top h1 em {
  font-family: Georgia, "Source Serif Pro", serif; font-style: italic; font-weight: 400;
  border-bottom: 2px solid var(--sunlight); padding-bottom: 1px;
}
.subtitle { font-size: 12px; color: #B9B4C7; margin-top: 4px; }
.top-stats { display: flex; gap: 24px; }
.top-stat { text-align: right; }
.top-stat .n { font-size: 26px; font-weight: 700; color: var(--sunlight); line-height: 1; }
.top-stat .l { font-size: 10px; color: #B9B4C7; text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }

nav.section-nav {
  background: var(--deepsleep); border-bottom: 1px solid #332d48; padding: 0 28px;
  display: flex; gap: 0; position: sticky; top: 0; z-index: 11;
}
nav.section-nav .section-btn {
  background: transparent; border: 0; padding: 12px 24px; font: inherit; font-weight: 700;
  color: #B9B4C7; cursor: pointer; border-bottom: 3px solid transparent; letter-spacing: 0.3px; font-size: 13px;
}
nav.section-nav .section-btn:hover { color: var(--pillow); }
nav.section-nav .section-btn.active { color: var(--sunlight); border-bottom-color: var(--sunlight); }
nav.section-nav .section-count {
  display: inline-block; background: rgba(255,255,255,0.1); color: inherit;
  font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 10px; margin-left: 6px;
}
nav.section-nav .section-btn.active .section-count { background: var(--sunlight); color: var(--deepsleep); }

nav.tabs { background: var(--linen); border-bottom: 1px solid var(--border); padding: 0 28px; display: flex; gap: 0; position: sticky; top: 45px; z-index: 10; flex-wrap: wrap; }
nav.tabs .tab-btn {
  background: transparent; border: 0; padding: 14px 20px; font: inherit; font-weight: 600;
  color: var(--muted); cursor: pointer; border-bottom: 3px solid transparent; letter-spacing: 0.2px;
}
nav.tabs .tab-btn:hover { color: var(--deepsleep); }
nav.tabs .tab-btn.active { color: var(--deepsleep); border-bottom-color: var(--sunlight); }

main { max-width: 1600px; margin: 0 auto; padding: 24px 28px 64px; }
.tab-panel { display: none; }
.tab-panel.active { display: block; }

h2 {
  font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em;
  color: var(--muted); font-weight: 600;
  margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border);
}
h2:first-child { margin-top: 0; }
h3 { font-size: 14px; font-weight: 600; margin: 18px 0 8px; }

.kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.kpi-card {
  background: var(--pillow); border: 1px solid var(--border); border-radius: 10px;
  padding: 18px 20px; display: flex; flex-direction: column; gap: 8px;
}
.kpi-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 600; }
.kpi-cols { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.kpi-col { text-align: left; }
.kpi-col .v { font-size: 22px; font-weight: 700; line-height: 1; }
.kpi-col .l { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 1px; margin-top: 3px; }
.kpi-col .delta { font-size: 10px; color: var(--muted); margin-top: 2px; }
.kpi-col .delta.up { color: var(--success); }
.kpi-col .delta.down { color: var(--danger); }
.goal-bar { height: 6px; background: var(--sky); border-radius: 3px; overflow: hidden; margin-top: 4px; }
.goal-bar .fill { height: 100%; background: var(--sunlight); }
.goal-text { font-size: 10px; color: var(--muted); margin-top: 4px; }

.alert {
  background: var(--pillow); border: 1px solid var(--border); border-left: 4px solid var(--muted);
  border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; gap: 16px;
}
.alert.warn { border-left-color: var(--sunlight); }
.alert.danger { border-left-color: var(--danger); }
.alert .title { font-weight: 600; }
.alert .detail { font-size: 12px; color: var(--muted); margin-top: 2px; }
.alert .go { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--deepsleep); font-weight: 600; background: var(--sunlight); padding: 6px 10px; border-radius: 4px; border: 0; cursor: pointer; }

.filter-row {
  display: flex; gap: 16px; flex-wrap: wrap; align-items: center;
  background: var(--linen); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px 16px; margin-bottom: 12px;
}
.filter-row label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 600; }
.filter-row input[type=text], .filter-row select {
  background: var(--pillow); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 10px; font: inherit; font-size: 12px; color: var(--deepsleep); min-width: 140px;
}
.filter-row input[type=range] { width: 140px; }
.filter-row .slider-group { display: flex; align-items: center; gap: 8px; }
.filter-row .slider-group .val { font-size: 11px; font-weight: 600; min-width: 36px; text-align: right; }

.count-pill { display: inline-block; background: var(--deepsleep); color: var(--sunlight); font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; margin-left: 6px; letter-spacing: 0.1em; }

table.dt {
  width: 100%; border-collapse: collapse; background: var(--pillow);
  border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
}
table.dt thead th {
  text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
  background: var(--linen); color: var(--muted); padding: 10px 12px;
  border-bottom: 1px solid var(--border); font-weight: 600; white-space: nowrap;
  cursor: pointer; user-select: none;
}
table.dt thead th:hover { color: var(--deepsleep); }
table.dt thead th.sorted::after { content: ' ▼'; font-size: 9px; }
table.dt thead th.sorted.asc::after { content: ' ▲'; }
table.dt tbody tr { border-bottom: 1px solid var(--border); }
table.dt tbody tr:hover { background: #FAFAF8; }
table.dt td { padding: 10px 12px; font-size: 12px; vertical-align: top; }
table.dt td.name a { color: var(--deepsleep); font-weight: 600; text-decoration: none; border-bottom: 1px dotted var(--muted); }
table.dt td.name a:hover { color: var(--deepsleep); border-bottom-color: var(--deepsleep); }
table.dt td.num { text-align: right; white-space: nowrap; }
.sev { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
.sev.high { background: var(--sunlight); color: var(--deepsleep); }
.sev.medium { background: var(--sky); color: var(--deepsleep); }
.sev.low { background: var(--linen); color: var(--muted); }
.owner { display: inline-block; font-size: 10px; font-weight: 600; padding: 2px 7px; border-radius: 10px; background: var(--sky); color: var(--deepsleep); }
.owner.patient { background: #E8D9F0; }
.owner.partner { background: var(--sunlight); }
.owner.daybreak { background: var(--sky); }
.owner.clinical { background: #C7E8D9; }
.owner.s2-sales { background: #FFD8D0; }
.owner.dentist { background: #D0E6FF; }
.owner.done { background: var(--linen); color: var(--muted); }
.subtle { color: var(--muted); font-size: 11px; }
.muted-row td { color: var(--muted); }
.empty { padding: 24px; text-align: center; color: var(--muted); background: var(--linen); border-radius: 8px; font-size: 12px; }

.notes-cell { max-width: 260px; font-size: 11px; }
.notes-cell.empty-note { color: #CCC8D4; }
.money { font-weight: 700; color: var(--success); }
.money-badge {
  display: inline-block; background: #E4F3EA; color: var(--success);
  font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 10px;
}
.kpi-col .money { font-size: 13px; }
.order-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.order-card { background: var(--pillow); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.order-card h3 { margin-top: 0; display: flex; justify-content: space-between; align-items: center; }
.order-card .big { font-size: 40px; font-weight: 700; line-height: 1; }
.order-card .sub { color: var(--muted); font-size: 11px; margin-top: 4px; }
.order-card.ordered { border-top: 4px solid var(--success); }
.order-card.unordered { border-top: 4px solid var(--sunlight); }
@media (max-width: 800px) { .order-grid { grid-template-columns: 1fr; } }

.feed { list-style: none; padding: 0; margin: 0; }
.feed li { padding: 10px 12px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: center; }
.feed li:hover { background: #FAFAF8; }
.feed .event-type { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 700; padding: 3px 8px; border-radius: 10px; white-space: nowrap; }
.feed .event-type.submitted { background: var(--sky); color: var(--deepsleep); }
.feed .event-type.activated { background: #C7E8D9; color: var(--deepsleep); }
.feed .event-type.converted { background: #FFD8D0; color: var(--deepsleep); }
.feed .event-type.delivered { background: var(--sunlight); color: var(--deepsleep); }
.feed .when { font-size: 11px; color: var(--muted); min-width: 110px; }
.feed a { color: var(--deepsleep); font-weight: 600; text-decoration: none; border-bottom: 1px dotted var(--muted); }
.feed a:hover { border-bottom-color: var(--deepsleep); }
.feed .acct { font-size: 11px; color: var(--muted); margin-left: auto; }

@media (max-width: 1100px) {
  .kpi-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 700px) {
  .kpi-grid { grid-template-columns: 1fr; }
  .kpi-cols { grid-template-columns: repeat(2, 1fr); }
}
  `.trim();
}

// ===== Client-side JS (runs in browser) =====

function clientJs() {
  // Return one big string — runs inside the generated HTML.
  return `
(function () {
  const D = window.__DASHBOARD__;
  if (!D) { console.error('No dashboard data'); return; }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtShort = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const fmtDT = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const daysAgoLabel = (n) => n == null ? '—' : (n === 0 ? 'today' : n === 1 ? 'yesterday' : n + 'd ago');
  const fmtUSD = (n) => (n == null || isNaN(n)) ? '—' : '$' + Math.round(n).toLocaleString('en-US');

  // ===== State =====
  const state = { section: 'master' };
  const sectionVariant = { master: null, billing: 'Billing', referral: 'Referral' };
  function filteredPatients() {
    const v = sectionVariant[state.section];
    return v ? D.patients.filter(p => p.variant === v) : D.patients;
  }
  function filteredEvents() {
    const v = sectionVariant[state.section];
    return v ? D.events.filter(e => e.variant === v) : D.events;
  }
  function filteredAccounts() {
    const v = sectionVariant[state.section];
    return v ? D.accSummary.filter(a => a.variant === v) : D.accSummary;
  }

  // ===== Top stats (recompute per section) =====
  function renderTopStats() {
    const t = D.totals[state.section];
    $('#topStats').innerHTML =
      '<div class="top-stat"><div class="n">' + t.active + '</div><div class="l">Active patients</div></div>' +
      '<div class="top-stat"><div class="n">' + t.stuck + '</div><div class="l">Need attention</div></div>' +
      '<div class="top-stat"><div class="n">' + t.awaitingActivation + '</div><div class="l">Awaiting activation</div></div>' +
      '<div class="top-stat"><div class="n">' + (t.accounts != null ? t.accounts : filteredAccounts().length) + '</div><div class="l">Partner locations</div></div>';
  }

  // ===== Tabs =====
  const renderers = {
    briefing: renderBriefing, action: renderAction, recent: renderRecent,
    accounts: renderAccounts, patients: renderPatients,
    ordered: renderOrdered, salesnotes: renderSalesNotes,
  };
  let activeTabName = 'briefing';
  function activateTab(name) {
    activeTabName = name;
    $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    const panel = $('#tab-' + name);
    if (panel) {
      // Always re-render on click so section changes propagate
      renderers[name](panel);
    }
  }
  function setSection(s) {
    state.section = s;
    $$('.section-btn').forEach(b => b.classList.toggle('active', b.dataset.section === s));
    // Show/hide conditional tabs
    $$('.tab-btn.only-billing').forEach(b => b.style.display = s === 'billing' ? '' : 'none');
    $$('.tab-btn.only-referral').forEach(b => b.style.display = s === 'referral' ? '' : 'none');
    // If on a tab that's no longer visible, snap to briefing
    if ((activeTabName === 'ordered' && s !== 'billing') || (activeTabName === 'salesnotes' && s !== 'referral')) {
      activeTabName = 'briefing';
    }
    renderTopStats();
    activateTab(activeTabName);
  }
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => activateTab(b.dataset.tab)));
  $$('.section-btn').forEach(b => b.addEventListener('click', () => setSection(b.dataset.section)));
  renderTopStats();
  activateTab('briefing');

  // ===== Briefing =====
  function renderBriefing(panel) {
    const k = D.kpi[state.section];
    const alerts = D.alerts[state.section];
    const card = (title, m, money) => {
      const goalBlock = m.goal > 0
        ? '<div class="goal-bar"><div class="fill" style="width:' + Math.min(100, Math.round(m.mtd / m.goal * 100)) + '%"></div></div>' +
          '<div class="goal-text">MTD goal: ' + m.mtd + ' / ' + m.goal + ' (' + Math.round(m.mtd / m.goal * 100) + '%)</div>'
        : '<div class="goal-text">No monthly goal set</div>';
      const d = m.today - m.yesterday;
      const deltaClass = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
      const deltaArrow = d > 0 ? '↑' : d < 0 ? '↓' : '→';
      const moneyRow = money ?
        '<div style="margin-top:8px; padding-top:8px; border-top:1px dashed var(--border); display:flex; justify-content:space-between; font-size:11px;">' +
          '<span class="subtle">Net paid</span>' +
          '<span class="money">' + fmtUSD(m.netPaidMtd) + ' MTD</span>' +
          '<span class="subtle"> &middot; ' + fmtUSD(m.netPaidLast7) + ' last 7d</span>' +
        '</div>' : '';
      return '<div class="kpi-card">' +
        '<div class="kpi-title">' + esc(title) + '</div>' +
        '<div class="kpi-cols">' +
          '<div class="kpi-col"><div class="v">' + m.today + '</div><div class="l">Today</div><div class="delta ' + deltaClass + '">' + deltaArrow + ' vs ' + m.yesterday + ' yest</div></div>' +
          '<div class="kpi-col"><div class="v">' + m.yesterday + '</div><div class="l">Yesterday</div></div>' +
          '<div class="kpi-col"><div class="v">' + m.last7 + '</div><div class="l">Last 7d</div></div>' +
          '<div class="kpi-col"><div class="v">' + m.mtd + '</div><div class="l">MTD</div></div>' +
        '</div>' + goalBlock + moneyRow +
      '</div>';
    };
    let html = '<h2>Today at a glance <span class="subtle" style="text-transform:none; letter-spacing:0;">· ' + state.section + ' scope</span></h2><div class="kpi-grid">' +
      card('New submissions', k.submissions) +
      card('New activations', k.activations) +
      card('New conversions (S2)', k.conversions, true) +
      card('Devices delivered', k.deliveries) +
    '</div>';

    html += '<h2>Alerts</h2>';
    if (!alerts.length) {
      html += '<div class="empty">No alerts — everything is tracking normally.</div>';
    } else {
      html += alerts.map(a =>
        '<div class="alert ' + esc(a.level) + '">' +
          '<div><div class="title">' + esc(a.title) + '</div><div class="detail">' + esc(a.detail) + '</div></div>' +
          '<button class="go" data-goto="' + esc(a.tab) + '">View →</button>' +
        '</div>').join('');
    }

    html += '<h2>Quick worklist counts</h2>';
    const ps = filteredPatients();
    const buckets = bucketCounts(ps);
    html += '<div class="kpi-grid">';
    html += quickCard('Awaiting activation', buckets.awaiting_activation, 'action');
    html += quickCard('Consent Hold pending', buckets.consent_hold, 'action');
    html += quickCard('Pre-Auth Hold pending', buckets.preauth_hold, 'action');
    html += quickCard('IK not returned', buckets.ik_not_returned, 'action');
    if (state.section !== 'billing') {
      html += quickCard('No Rx written', buckets.no_rx, 'action');
      html += quickCard('No S2 conversion', buckets.no_conversion, 'action');
    }
    html += quickCard('Epworth incomplete', buckets.epworth, 'action');
    html += quickCard('Total active', ps.length, 'patients');
    html += '</div>';

    panel.innerHTML = html;
    $$('button.go, .kpi-card[data-goto]', panel).forEach(b =>
      b.addEventListener('click', () => activateTab(b.dataset.goto)));
    $$('.kpi-card[data-goto]', panel).forEach(c => {
      c.style.cursor = 'pointer';
      c.addEventListener('click', () => activateTab(c.dataset.goto));
    });
  }

  function quickCard(title, n, tab) {
    return '<div class="kpi-card" data-goto="' + esc(tab) + '" style="cursor:pointer;">' +
      '<div class="kpi-title">' + esc(title) + '</div>' +
      '<div style="font-size:32px; font-weight:700; line-height:1;">' + n + '</div>' +
      '<div class="subtle">Click to open →</div>' +
    '</div>';
  }

  function bucketCounts(ps) {
    const out = { awaiting_activation:0, consent_hold:0, preauth_hold:0, ik_not_returned:0, no_rx:0, no_conversion:0, epworth:0 };
    ps.forEach(p => { if (p.stuckBucket && out.hasOwnProperty(p.stuckBucket)) out[p.stuckBucket]++; });
    return out;
  }

  // ===== Action Queue =====
  function renderAction(panel) {
    const stuck = filteredPatients().filter(p => p.stuckBucket);
    stuck.sort((a, b) => (a.daysStuck || 0) - (b.daysStuck || 0)); // newest-first
    const groups = [
      { id: 'awaiting_activation', label: 'Awaiting activation', hint: 'Submitted but not yet logged in. Chase first — nothing else can move until they activate.' },
      { id: 'consent_hold',        label: 'Consent Hold pending', hint: 'Partner action: collect copay and release Consent Hold in portal.' },
      { id: 'preauth_hold',        label: 'Pre-Auth Hold pending', hint: 'Partner action: secure pre-authorization and release Pre-Auth Hold.' },
      { id: 'ik_not_returned',     label: 'Impression kit not returned', hint: 'Daybreak: chase patient; may need replacement kit after 30d.' },
      { id: 'no_rx',               label: 'No Rx written (referral)', hint: 'Daybreak clinical: advance Rx workflow.' },
      { id: 'no_conversion',       label: 'No S2 conversion (referral)', hint: 'S2 sales: follow up with patient who has Rx but hasn\\'t purchased.' },
      { id: 'epworth',             label: 'Epworth incomplete', hint: 'Patient: complete Epworth Sleep Scale.' },
    ];
    let html = '<h2>Action queue <span class="count-pill">' + stuck.length + '</span></h2>';
    html += '<div class="filter-row">' +
      '<label>Days stuck</label>' +
      '<div class="slider-group"><span class="val" id="dsMin">0</span>' +
        '<input type="range" id="dsRangeMin" min="0" max="90" value="0">' +
        '<span>—</span>' +
        '<input type="range" id="dsRangeMax" min="0" max="90" value="90">' +
      '<span class="val" id="dsMax">90</span></div>' +
      '<label>Partner</label>' +
      '<select id="fPartner"><option value="">All partners</option>' +
        Array.from(new Set(stuck.map(p => p.accountName))).sort().map(n => '<option>' + esc(n) + '</option>').join('') +
      '</select>' +
      '<label>Severity</label>' +
      '<select id="fSev"><option value="">Any</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select>' +
    '</div>';
    html += '<div id="actionGroups"></div>';
    panel.innerHTML = html;

    const render = () => {
      const minD = parseInt($('#dsRangeMin').value, 10);
      const maxD = parseInt($('#dsRangeMax').value, 10);
      $('#dsMin').textContent = minD;
      $('#dsMax').textContent = maxD;
      const partner = $('#fPartner').value;
      const sev = $('#fSev').value;
      const filtered = stuck.filter(p =>
        (p.daysStuck == null || (p.daysStuck >= minD && p.daysStuck <= maxD)) &&
        (!partner || p.accountName === partner) &&
        (!sev || p.stuckSeverity === sev));
      $('#actionGroups').innerHTML = groups.map(g => {
        const rows = filtered.filter(p => p.stuckBucket === g.id);
        if (!rows.length) return '';
        return '<h3>' + esc(g.label) + ' <span class="count-pill">' + rows.length + '</span></h3>' +
          '<div class="subtle" style="margin-bottom:6px;">' + esc(g.hint) + '</div>' +
          patientTable(rows, ['name','partner','stage','nextStep','salesNotes','daysStuck','severity'], 'action-' + g.id);
      }).join('') || '<div class="empty">No patients match the current filters.</div>';
      attachSort();
    };
    $('#dsRangeMin').oninput = render;
    $('#dsRangeMax').oninput = render;
    $('#fPartner').onchange = render;
    $('#fSev').onchange = render;
    render();
  }

  // ===== Recent activity =====
  function renderRecent(panel) {
    const evs = filteredEvents();
    // Decorate converted events with $ amount via patient lookup
    const patientById = new Map(D.patients.map(p => [p.id, p]));
    let html = '<h2>Recent activity <span class="count-pill">' + evs.length + '</span></h2>';
    html += '<div class="filter-row">' +
      '<label>Type</label>' +
      '<select id="fEvent"><option value="">All events</option><option>submitted</option><option>activated</option><option>converted</option><option>delivered</option></select>' +
      '<label>Partner</label>' +
      '<select id="fEventPartner"><option value="">All partners</option>' +
        Array.from(new Set(evs.map(e => e.accountName))).sort().map(n => '<option>' + esc(n) + '</option>').join('') +
      '</select>' +
      '<label>Limit</label>' +
      '<select id="fLimit"><option value="100">100</option><option value="250">250</option><option value="500">500</option><option value="9999">All</option></select>' +
    '</div>';
    html += '<ul class="feed" id="feed"></ul>';
    panel.innerHTML = html;

    const render = () => {
      const type = $('#fEvent').value, partner = $('#fEventPartner').value, lim = parseInt($('#fLimit').value, 10);
      const filtered = evs.filter(e => (!type || e.type === type) && (!partner || e.accountName === partner)).slice(0, lim);
      $('#feed').innerHTML = filtered.map(e => {
        const p = patientById.get(e.patientId);
        const moneyBadge = (e.type === 'converted' && p && p.netPaid) ? ' <span class="money-badge">' + fmtUSD(p.netPaid) + '</span>' : '';
        return '<li>' +
          '<span class="when">' + esc(fmtDT(e.date)) + '</span>' +
          '<span class="event-type ' + esc(e.type) + '">' + esc(e.label) + '</span>' +
          '<a href="' + esc(e.sfUrl) + '" target="_blank" rel="noopener">' + esc(e.name) + '</a>' +
          moneyBadge +
          '<span class="acct">' + esc(e.accountName) + '</span>' +
        '</li>';
      }).join('') || '<div class="empty">No events match.</div>';
    };
    $('#fEvent').onchange = render;
    $('#fEventPartner').onchange = render;
    $('#fLimit').onchange = render;
    render();
  }

  // ===== Accounts =====
  function renderAccounts(panel) {
    const rows = filteredAccounts().slice().sort((a,b) => b.active - a.active);
    let html = '<h2>Partner locations <span class="count-pill">' + rows.length + '</span></h2>';
    html += '<table class="dt" id="accTbl"><thead><tr>' +
      '<th data-sort="name">Location</th>' +
      '<th data-sort="parent">Parent</th>' +
      '<th data-sort="owner">Owner</th>' +
      '<th data-sort="variant">Variant</th>' +
      '<th data-sort="active" class="num">Active</th>' +
      '<th data-sort="submittedLast7" class="num">New 7d</th>' +
      '<th data-sort="submittedMTD" class="num">New MTD</th>' +
      '<th data-sort="deliveredMTD" class="num">Delivered MTD</th>' +
      '<th data-sort="convertedMTD" class="num">Converted MTD</th>' +
      '<th data-sort="awaitingActivation" class="num">Awaiting act.</th>' +
      '<th data-sort="stuck" class="num">Stuck</th>' +
    '</tr></thead><tbody>' +
    rows.map(r => '<tr>' +
      '<td><strong>' + esc(r.name) + '</strong></td>' +
      '<td class="subtle">' + esc(r.parent) + '</td>' +
      '<td class="subtle">' + esc(r.owner) + '</td>' +
      '<td>' + esc(r.variant) + '</td>' +
      '<td class="num">' + r.active + '</td>' +
      '<td class="num">' + r.submittedLast7 + '</td>' +
      '<td class="num">' + r.submittedMTD + '</td>' +
      '<td class="num">' + r.deliveredMTD + '</td>' +
      '<td class="num">' + r.convertedMTD + '</td>' +
      '<td class="num">' + r.awaitingActivation + '</td>' +
      '<td class="num">' + r.stuck + '</td>' +
    '</tr>').join('') +
    '</tbody></table>';
    panel.innerHTML = html;
    attachSortTo($('#accTbl'), rows);
  }

  // ===== All Patients =====
  function renderPatients(panel) {
    const ps = filteredPatients();
    let html = '<h2>All active patients <span class="count-pill">' + ps.length + '</span></h2>';
    html += '<div class="filter-row">' +
      '<label>Search</label><input type="text" id="fSearch" placeholder="Name, patient ID, email…" style="min-width:220px;">' +
      '<label>Partner</label>' +
      '<select id="fP"><option value="">All</option>' +
        Array.from(new Set(ps.map(p => p.accountName))).sort().map(n => '<option>' + esc(n) + '</option>').join('') +
      '</select>' +
      '<label>Stage</label>' +
      '<select id="fStage"><option value="">All stages</option>' +
        Array.from(new Set(ps.map(p => p.stageName))).sort().map(n => '<option>' + esc(n) + '</option>').join('') +
      '</select>' +
      '<label>Variant</label>' +
      '<select id="fV"><option value="">Both</option><option>Billing</option><option>Referral</option></select>' +
      '<label>Severity</label>' +
      '<select id="fSev2"><option value="">Any</option><option value="">(no filter)</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option><option value="none">No issue</option></select>' +
    '</div>';
    html += '<div class="filter-row">' +
      '<label>Days since submission ≤</label>' +
      '<div class="slider-group"><input type="range" id="sSub" min="0" max="365" value="365"><span class="val" id="sSubVal">∞</span></div>' +
      '<label>Days since last activity ≤</label>' +
      '<div class="slider-group"><input type="range" id="sAct" min="0" max="365" value="365"><span class="val" id="sActVal">∞</span></div>' +
    '</div>';
    html += '<div id="patientTbl"></div>';
    panel.innerHTML = html;

    const render = () => {
      const q = $('#fSearch').value.toLowerCase().trim();
      const partner = $('#fP').value, stage = $('#fStage').value, variant = $('#fV').value, sev = $('#fSev2').value;
      const maxSub = parseInt($('#sSub').value, 10);
      const maxAct = parseInt($('#sAct').value, 10);
      $('#sSubVal').textContent = maxSub >= 365 ? '∞' : maxSub;
      $('#sActVal').textContent = maxAct >= 365 ? '∞' : maxAct;
      const filtered = ps.filter(p =>
        (!q || (p.name || '').toLowerCase().includes(q) || (p.patientId || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q)) &&
        (!partner || p.accountName === partner) &&
        (!stage || p.stageName === stage) &&
        (!variant || p.variant === variant) &&
        (!sev ? true : sev === 'none' ? !p.stuckBucket : p.stuckSeverity === sev) &&
        (maxSub >= 365 || (p.daysSinceSubmitted != null && p.daysSinceSubmitted <= maxSub)) &&
        (maxAct >= 365 || (p.daysSinceActivity != null && p.daysSinceActivity <= maxAct)));
      $('#patientTbl').innerHTML = patientTable(filtered, ['name','partner','variant','stage','lastActivity','nextStep','salesNotes','submitted','severity'], 'all-patients');
      attachSort();
    };
    $('#fSearch').oninput = render;
    $('#fP').onchange = render;
    $('#fStage').onchange = render;
    $('#fV').onchange = render;
    $('#fSev2').onchange = render;
    $('#sSub').oninput = render;
    $('#sAct').oninput = render;
    render();
  }

  // ===== Ordered vs Unordered (Billing-only) =====
  function renderOrdered(panel) {
    // "Ordered" = Patient_Consent_Hold_Released__c is true; "Unordered" = activated but not yet consent-released
    const ps = filteredPatients().filter(p => p.variant === 'Billing');
    const activated = ps.filter(p => !!p.activated);
    const ordered = activated.filter(p => p.consentReleased);
    const unordered = activated.filter(p => !p.consentReleased && !p.delivered);
    ordered.sort((a, b) => new Date(b.submitted || 0) - new Date(a.submitted || 0));
    unordered.sort((a, b) => (a.daysSinceActivated || 0) - (b.daysSinceActivated || 0));

    const deliveredFromOrdered = ordered.filter(p => p.delivered).length;
    const pctOrdered = activated.length ? Math.round(ordered.length / activated.length * 100) : 0;

    let html = '<h2>Ordered vs unordered devices</h2>';
    html += '<div class="order-grid">';
    html += '<div class="order-card ordered">' +
      '<h3>Ordered <span class="count-pill">' + ordered.length + '</span></h3>' +
      '<div class="big">' + pctOrdered + '%</div>' +
      '<div class="sub">of activated patients (' + ordered.length + ' / ' + activated.length + '). ' + deliveredFromOrdered + ' delivered.</div>' +
    '</div>';
    html += '<div class="order-card unordered">' +
      '<h3>Unordered <span class="count-pill">' + unordered.length + '</span></h3>' +
      '<div class="big">' + unordered.length + '</div>' +
      '<div class="sub">Activated patients waiting for Consent Hold release. This is the next $ opportunity.</div>' +
    '</div>';
    html += '</div>';

    html += '<h2>Unordered — activated, waiting for Consent Hold release</h2>';
    html += '<div class="filter-row">' +
      '<label>Partner</label>' +
      '<select id="fPO"><option value="">All</option>' +
        Array.from(new Set(unordered.map(p => p.accountName))).sort().map(n => '<option>' + esc(n) + '</option>').join('') +
      '</select>' +
      '<label>Days since activation ≤</label>' +
      '<div class="slider-group"><input type="range" id="sActOrd" min="0" max="180" value="180"><span class="val" id="sActOrdVal">∞</span></div>' +
    '</div>';
    html += '<div id="unorderedTbl"></div>';

    html += '<h2>Recently ordered — awaiting delivery</h2>';
    const orderedAwaiting = ordered.filter(p => !p.delivered)
      .sort((a, b) => new Date(b.submitted || 0) - new Date(a.submitted || 0));
    html += '<div id="orderedTbl"></div>';
    panel.innerHTML = html;

    const redraw = () => {
      const partner = $('#fPO').value;
      const maxAct = parseInt($('#sActOrd').value, 10);
      $('#sActOrdVal').textContent = maxAct >= 180 ? '∞' : maxAct;
      const uFiltered = unordered.filter(p =>
        (!partner || p.accountName === partner) &&
        (maxAct >= 180 || (p.daysSinceActivated != null && p.daysSinceActivated <= maxAct)));
      $('#unorderedTbl').innerHTML = patientTable(uFiltered,
        ['name','partner','stage','lastActivity','nextStep','salesNotes','submitted'], 'unordered');
      $('#orderedTbl').innerHTML = patientTable(orderedAwaiting,
        ['name','partner','stage','lastActivity','nextStep','submitted'], 'ordered-await');
      attachSort();
    };
    $('#fPO').onchange = redraw;
    $('#sActOrd').oninput = redraw;
    redraw();
  }

  // ===== Sales Notes Outreach (Referral-only) =====
  function renderSalesNotes(panel) {
    // Unconverted referral patients with Sales_Notes__c populated, not yet delivered
    const ps = filteredPatients().filter(p => p.variant === 'Referral' && p.salesNotes && !p.converted && !p.delivered);
    ps.sort((a, b) => (a.daysSinceActivity == null ? 1e6 : a.daysSinceActivity) - (b.daysSinceActivity == null ? 1e6 : b.daysSinceActivity));

    let html = '<h2>Sales notes outreach <span class="count-pill">' + ps.length + '</span></h2>';
    html += '<div class="subtle" style="margin-bottom:12px;">Referral patients who have sales notes on their Contact but haven\\'t converted yet. Newest activity first — these are the warmest leads.</div>';

    html += '<div class="filter-row">' +
      '<label>Search notes</label><input type="text" id="fSnSearch" placeholder="Keyword in notes or name…" style="min-width:260px;">' +
      '<label>Partner</label>' +
      '<select id="fSnP"><option value="">All</option>' +
        Array.from(new Set(ps.map(p => p.accountName))).sort().map(n => '<option>' + esc(n) + '</option>').join('') +
      '</select>' +
      '<label>Days since activity ≤</label>' +
      '<div class="slider-group"><input type="range" id="sSnAct" min="0" max="180" value="180"><span class="val" id="sSnActVal">∞</span></div>' +
      '<label>Has Rx</label>' +
      '<select id="fSnRx"><option value="">Any</option><option value="yes">Yes</option><option value="no">No</option></select>' +
    '</div>';
    html += '<div id="snTbl"></div>';
    panel.innerHTML = html;

    const redraw = () => {
      const q = $('#fSnSearch').value.toLowerCase().trim();
      const partner = $('#fSnP').value;
      const maxAct = parseInt($('#sSnAct').value, 10);
      $('#sSnActVal').textContent = maxAct >= 180 ? '∞' : maxAct;
      const rxFilter = $('#fSnRx').value;
      const filtered = ps.filter(p =>
        (!q || (p.salesNotes || '').toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q)) &&
        (!partner || p.accountName === partner) &&
        (maxAct >= 180 || (p.daysSinceActivity != null && p.daysSinceActivity <= maxAct)) &&
        (!rxFilter || (rxFilter === 'yes' ? !!p.rx : !p.rx)));
      $('#snTbl').innerHTML = patientTable(filtered,
        ['name','partner','stage','lastActivity','salesNotes','nextStep','submitted'], 'salesnotes');
      attachSort();
    };
    $('#fSnSearch').oninput = redraw;
    $('#fSnP').onchange = redraw;
    $('#sSnAct').oninput = redraw;
    $('#fSnRx').onchange = redraw;
    redraw();
  }

  // ===== Patient table renderer (shared) =====
  function patientTable(rows, cols, tableId) {
    if (!rows.length) return '<div class="empty">No patients match.</div>';
    const colDefs = {
      name:         { label: 'Patient', sort: 'name', render: p => {
        const money = (p.netPaid && p.converted) ? ' <span class="money-badge">' + fmtUSD(p.netPaid) + '</span>' : '';
        return '<td class="name"><a href="' + esc(p.sfUrl) + '" target="_blank" rel="noopener">' + esc(p.name) + '</a>' + money + (p.patientId ? '<div class="subtle">ID: ' + esc(p.patientId) + '</div>' : '') + '</td>';
      } },
      netPaid:      { label: 'Net paid', sort: 'netPaid', render: p => '<td class="num">' + (p.netPaid ? '<span class="money">' + fmtUSD(p.netPaid) + '</span>' : '<span class="subtle">—</span>') + '</td>' },
      partner:      { label: 'Partner', sort: 'accountName', render: p => '<td class="subtle">' + esc(p.accountName) + '</td>' },
      variant:      { label: 'Variant', sort: 'variant', render: p => '<td>' + esc(p.variant) + '</td>' },
      stage:        { label: 'Current stage', sort: 'daysAtStage', render: p => '<td>' + esc(p.stageName) + '<div class="subtle">' + (p.daysAtStage != null ? p.daysAtStage + 'd' : '—') + ' at stage</div></td>' },
      lastActivity: { label: 'Last activity', sort: 'daysSinceActivity', render: p => '<td class="subtle">' + daysAgoLabel(p.daysSinceActivity) + '</td>' },
      nextStep:     { label: 'Next step', sort: 'nextStep', render: p => '<td>' + esc(p.nextStep) + ' <span class="owner ' + esc(p.nextOwner) + '">' + esc(p.nextOwner) + '</span></td>' },
      salesNotes:   { label: 'Sales notes', sort: 'salesNotes', render: p => '<td class="notes-cell ' + (p.salesNotes ? '' : 'empty-note') + '">' + (p.salesNotes ? esc(p.salesNotes) : '—') + '</td>' },
      submitted:    { label: 'Submitted', sort: 'submitted', render: p => '<td class="subtle">' + esc(fmtShort(p.submitted)) + (p.daysSinceSubmitted != null ? '<div class="subtle">' + p.daysSinceSubmitted + 'd ago</div>' : '') + '</td>' },
      daysStuck:    { label: 'Days stuck', sort: 'daysStuck', render: p => '<td class="num">' + (p.daysStuck != null ? p.daysStuck + 'd' : '—') + '</td>' },
      severity:     { label: 'Sev', sort: 'stuckSeverity', render: p => '<td>' + (p.stuckSeverity ? '<span class="sev ' + p.stuckSeverity + '">' + p.stuckSeverity + '</span>' : '—') + '</td>' },
    };
    const head = cols.map(k => '<th data-sort="' + esc(colDefs[k].sort) + '">' + esc(colDefs[k].label) + '</th>').join('');
    const body = rows.map(p => '<tr>' + cols.map(k => colDefs[k].render(p)).join('') + '</tr>').join('');
    return '<table class="dt" data-tid="' + esc(tableId) + '"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function attachSort() {
    $$('table.dt').forEach(t => attachSortTo(t));
  }
  function attachSortTo(table, sourceRows) {
    $$('thead th', table).forEach(th => {
      th.onclick = () => {
        const key = th.dataset.sort;
        if (!key) return;
        const cur = table.dataset.sortKey;
        let asc = table.dataset.sortAsc === 'true';
        if (cur === key) asc = !asc; else asc = false;
        table.dataset.sortKey = key;
        table.dataset.sortAsc = String(asc);
        // Sort DOM rows by the value in the corresponding cell, using data-val attr if present,
        // else inner text numeric parse or string
        const idx = Array.from(th.parentNode.children).indexOf(th);
        const tbody = $('tbody', table);
        const rows = Array.from(tbody.children);
        rows.sort((a, b) => {
          const ta = (a.children[idx].textContent || '').trim();
          const tb = (b.children[idx].textContent || '').trim();
          const na = parseFloat(ta), nb = parseFloat(tb);
          const cmp = (!isNaN(na) && !isNaN(nb)) ? (na - nb) : ta.localeCompare(tb);
          return asc ? cmp : -cmp;
        });
        rows.forEach(r => tbody.appendChild(r));
        $$('thead th', table).forEach(x => x.classList.remove('sorted', 'asc'));
        th.classList.add('sorted');
        if (asc) th.classList.add('asc');
      };
    });
  }
})();
  `.trim();
}

try { main(); } catch (e) {
  console.error(`[internal-dashboard] ERROR: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
