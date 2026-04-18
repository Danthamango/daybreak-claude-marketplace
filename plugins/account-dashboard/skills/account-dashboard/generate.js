#!/usr/bin/env node
// Generates an executive dashboard (single self-contained HTML file) for any
// Billing partner account in Salesforce. Auto-resolves the account hierarchy:
// Organization -> Billing Location -> Location, OR Billing Location -> Location,
// OR a single Location.
//
// Usage:
//   node generate.js --account "Advent Org"
//   node generate.js --account 001TN00000LlMgvYAF
//   node generate.js --account "Advent" --out /path/to/out.html

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--account') out.account = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node generate.js --account <name-or-id> [--out <file>]
  --account   Account name (fuzzy match) or 18-char Account ID.
              Can be an Organization, Billing Location, or Location.
  --out       Output HTML path. Defaults to output/account-dashboard/<slug>.html
  --help      Show this message.`);
}

function sfQuery(soql) {
  const raw = execSync(
    `sf data query --query "${soql.replace(/"/g, '\\"')}" --result-format json`,
    { maxBuffer: 500 * 1024 * 1024 }
  ).toString();
  const parsed = JSON.parse(raw);
  if (parsed.status !== 0) throw new Error('SF query failed: ' + raw);
  return parsed.result.records;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function resolveRootAccount(input) {
  const isId = /^001[a-zA-Z0-9]{12,15}$/.test(input);
  let records;
  if (isId) {
    records = sfQuery(
      `SELECT Id, Name, RecordType.Name, ParentId FROM Account WHERE Id = '${input}'`
    );
  } else {
    const escaped = input.replace(/'/g, "\\'");
    records = sfQuery(
      `SELECT Id, Name, RecordType.Name, ParentId FROM Account WHERE Name LIKE '%${escaped}%' ORDER BY Name LIMIT 50`
    );
    const roots = records.filter(
      (r) => r.RecordType && (r.RecordType.Name === 'Organization' || r.RecordType.Name === 'Billing Location')
    );
    if (roots.length === 1) return roots[0];
    if (roots.length > 1) {
      const org = roots.find((r) => r.RecordType.Name === 'Organization');
      if (org) return org;
    }
    if (records.length === 1) return records[0];
    if (records.length === 0) throw new Error(`No Account matched "${input}"`);
    const names = records.map((r) => `  - ${r.Name} (${r.RecordType?.Name || '?'})`).join('\n');
    throw new Error(`Ambiguous account "${input}". Matches:\n${names}\nRe-run with exact name or Id.`);
  }
  if (!records.length) throw new Error(`No Account with Id ${input}`);
  return records[0];
}

function resolveLocations(root) {
  const rt = root.RecordType?.Name;
  if (rt === 'Location') {
    const full = sfQuery(
      `SELECT Id, Name, BillingState, ShippingState FROM Account WHERE Id = '${root.Id}'`
    );
    return { rootType: 'Location', locations: full };
  }
  if (rt === 'Billing Location') {
    const locs = sfQuery(
      `SELECT Id, Name, BillingState, ShippingState FROM Account WHERE ParentId = '${root.Id}' AND RecordType.Name = 'Location' ORDER BY Name`
    );
    return { rootType: 'Billing Location', locations: locs };
  }
  if (rt === 'Organization') {
    const billings = sfQuery(
      `SELECT Id FROM Account WHERE ParentId = '${root.Id}' AND RecordType.Name = 'Billing Location'`
    );
    if (!billings.length) return { rootType: 'Organization', locations: [] };
    const ids = billings.map((b) => `'${b.Id}'`).join(',');
    const locs = sfQuery(
      `SELECT Id, Name, BillingState, ShippingState FROM Account WHERE ParentId IN (${ids}) AND RecordType.Name = 'Location' ORDER BY Name`
    );
    return { rootType: 'Organization', locations: locs };
  }
  throw new Error(`Unsupported RecordType "${rt}" on root account ${root.Name}. Expected Organization, Billing Location, or Location.`);
}

function stripPrefix(name, root) {
  const rootStem = root.Name.replace(/\b(Org|Billing|Location)\b/gi, '').trim();
  const re = new RegExp('^' + rootStem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–]\\s*', 'i');
  return name.replace(re, '').trim() || name;
}

function fetchContacts(locationIds) {
  if (!locationIds.length) return [];
  const fields = [
    'Id',
    'LastName',
    'AccountId',
    'Patient_ID__c',
    'Referral_MRN__c',
    'CreatedDate',
    'Auth0_Registration_Date__c',
    'Patient_Consent_Hold_Released__c',
    'Patient_Consent_Hold_Released_Date__c',
    'MAD_Shipped_Date__c',
    'MAD_Delivered_Date__c',
  ].join(', ');
  const all = [];
  const chunkSize = 150;
  for (let i = 0; i < locationIds.length; i += chunkSize) {
    const chunk = locationIds.slice(i, i + chunkSize).map((id) => `'${id}'`).join(',');
    const rows = sfQuery(
      `SELECT ${fields} FROM Contact WHERE AccountId IN (${chunk})`
    );
    all.push(...rows);
  }
  return all;
}

function phiId(c) {
  if (c.Patient_ID__c) return String(c.Patient_ID__c);
  if (c.Referral_MRN__c) return String(c.Referral_MRN__c);
  const last = (c.LastName || '').trim();
  const tail = (c.Id || '').slice(-4);
  return last ? `${last}-${tail}` : `Patient-${tail}`;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.account) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  console.log(`Resolving account: "${args.account}"`);
  const root = resolveRootAccount(args.account);
  console.log(`  -> ${root.Name} (${root.RecordType?.Name}) [${root.Id}]`);

  console.log('Resolving locations...');
  const { rootType, locations } = resolveLocations(root);
  console.log(`  ${locations.length} location(s)`);

  const scopes = {
    rootName: root.Name,
    rootType,
    locations: locations.map((l) => ({
      id: l.Id,
      name: stripPrefix(l.Name, root),
      fullName: l.Name,
      state: l.BillingState || l.ShippingState || 'Unknown',
    })),
  };

  console.log('Fetching contacts...');
  const contacts = fetchContacts(locations.map((l) => l.Id));
  console.log(`  ${contacts.length} contacts`);

  const locMap = Object.fromEntries(scopes.locations.map((l) => [l.id, l]));
  const patients = contacts.map((c) => {
    const loc = locMap[c.AccountId] || { name: 'Unknown', state: 'Unknown' };
    return {
      id: phiId(c),
      locId: c.AccountId,
      loc: loc.name,
      state: loc.state,
      submitted: c.CreatedDate || null,
      activated: c.Auth0_Registration_Date__c || null,
      ordered: c.Patient_Consent_Hold_Released__c === true,
      orderedDate: c.Patient_Consent_Hold_Released_Date__c || null,
      shipped: c.MAD_Shipped_Date__c || null,
      delivered: c.MAD_Delivered_Date__c || null,
    };
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    account: { id: root.Id, name: root.Name, recordType: rootType },
    scopes,
    patients,
  };

  const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const html = template
    .replace(/\{\{ACCOUNT_NAME\}\}/g, root.Name)
    .replace(
      '/*__DATA__*/',
      'window.__DASHBOARD_DATA__ = ' + JSON.stringify(payload) + ';'
    );

  const outPath = args.out
    ? path.resolve(args.out)
    : path.resolve(process.cwd(), 'output', 'account-dashboard', slugify(root.Name) + '.html');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`Wrote ${outPath} (${sizeKb} KB)`);
}

main();
