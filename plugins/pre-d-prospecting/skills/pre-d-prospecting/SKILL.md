---
name: pre-d-prospecting
description: >
  Automated physician prospecting pipeline from Salesforce sleep test results. Runs a SOQL query for
  today's sleep test result files, de-duplicates contacts, downloads and parses each PDF to extract the
  referring/interpreting physician, their organization, and AHI severity, then researches the physician
  via Apollo.io, and drafts a personalized outreach email following Daybreak's copy rules.
  Use this skill when the user says "pre-d prospecting", "run prospecting", "physician outreach",
  "sleep test prospecting", "today's referrals", "run the pre-d pipeline", or anything about
  finding and emailing physicians from today's sleep test results.
---

# Pre-D Prospecting Pipeline

This skill automates the daily physician prospecting workflow for Daybreak Sleep. It turns today's
incoming sleep test results into personalized physician outreach emails — from raw Salesforce data
to send-ready drafts.

## Prerequisites

- Salesforce CLI (`sf`) authenticated to the Daybreak org
- PATH must include Node.js and npm global bin:
  ```
  export PATH="/c/Program Files/nodejs:/c/Users/PC/AppData/Roaming/npm:$PATH"
  ```
- Apollo.io MCP connection (for physician email lookup)
- The outreach copy rules at `references/Daybreak_Outreach_Prompt.md` (bundled with this skill)
- Poppler installed (for PDF-to-image conversion). Binary at:
  ```
  /c/Users/PC/AppData/Local/Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin
  ```

## Important Implementation Notes (from production testing)

These notes reflect actual behavior observed during pipeline testing:

1. **PDF Download**: The `File_URL__c` URLs redirect (302) from `api.thedaybreak.com` to Azure Blob
   Storage. Use `curl -sL` to follow redirects and download the PDF locally.

2. **PDF Reading**: Most sleep test PDFs are image-based (no text layer). Use `pdftoppm` to convert
   pages to JPEG images, then use the Read tool to visually read the images. Do NOT rely on
   `pdftotext` — it returns empty output for most reports.
   ```bash
   POPPLER_BIN="/c/Users/PC/AppData/Local/Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin"
   export PATH="$POPPLER_BIN:$PATH"
   pdftoppm -jpeg -r 200 -f 1 -l 2 input.pdf output_prefix
   ```
   Font warnings from pdftoppm are cosmetic and can be ignored.

   **Image dimension limit (IMPORTANT)**: When reading multiple images in a single request, each
   image must be ≤ 2000px on its longest side. If a generated page image exceeds this, the Read
   call will fail with a dimension error and halt progress. To handle this gracefully:

   - Before reading, check dimensions with ImageMagick `identify` (if available) or Node's
     `fs.statSync` + image header parsing. Example quick check using `identify`:
     ```bash
     identify -format "%w %h" page.jpg
     ```
   - If either dimension exceeds 2000px, **re-render that page at a lower DPI** before reading:
     ```bash
     pdftoppm -jpeg -r 120 -f 1 -l 2 input.pdf output_prefix
     ```
   - If the image still exceeds 2000px after re-rendering at 120 DPI, or if the Read call fails
     with a dimension/size error, **skip that specific page/image and continue** with the next
     page or next PDF. Do NOT cancel the pipeline run. Log the skip in a `skipped_images` array
     (contact_id, file path, reason) and continue extraction from any remaining readable pages.
   - If ALL pages of a PDF are skipped, mark the physician/org/AHI fields as "Not identified"
     for that contact and move on — the pipeline must continue for the remaining contacts.

3. **PDF Formats Vary**: Sleep test reports come from many different labs and systems:
   - Daybreak-branded reports (NightOwl device) — may not have an external referring physician
   - Hospital/health system reports (Stony Brook, North Mississippi, etc.)
   - Independent sleep center reports (Treasure Coast Sleep Disorders, Virginia Heart)
   Look for physician info in: headers, signature blocks, CC lines, and "Referring Physician",
   "Ordering Provider", "Report Prepared By", "Electronically Signed By" fields.

4. **Apollo.io Limitations**: Many healthcare providers have no email in Apollo's database. Expect
   a low hit rate (~20-30%). When `apollo_people_match` returns no email, flag for manual lookup.
   Apollo enrichment consumes 1 credit per lookup — get user confirmation before bulk enriching.

5. **Windows Path Issues**: When running Node.js scripts, use `process.env.USERPROFILE` for file
   paths instead of `/tmp/` (bash `/tmp` maps differently than Node's `C:\tmp`).

6. **De-duplication Script**: Use Node.js (not Python) for data processing since Python may not
   be installed. Write scripts to the working directory and use `path.join(homeDir, ...)` for paths.

## Pipeline Steps

Execute these steps in order. After each step, report a brief status update to the user.

### Step 1: Query Salesforce for Today's Sleep Test Results

Run this SOQL query. Save it to a temp file first to avoid shell escaping issues with `!=`:

```
SELECT Id, File_URL__c, Contact__c, Contact__r.RecordType.Name,
       Contact__r.Account.Name, CreatedDate
FROM Contact_File__c
WHERE Contact__r.External_Sleep_Test__c = true
AND Contact__r.MailingStreet != null
AND Contact__r.Auth0_Registration_Date__c != null
AND Contact__r.Account.Name = 'Daybreak - Direct'
AND Type__c = 'Sleep Test Result'
AND CreatedDate = TODAY
```

Write the query to `/tmp/sfquery.txt` and run:
```bash
sf data query --result-format json --file /tmp/sfquery.txt
```

If the output is large, read from the persisted output file. Parse the JSON result.

### Step 2: De-duplicate by Contact

Group all returned rows by `Contact__c` (the Contact ID). Multiple files can exist per contact.

### Step 3: Keep Most Recent per Contact

For each Contact ID group, keep only the row with the latest `CreatedDate`. This gives one
Contact_File__c record per unique contact — the most recent sleep test result.

### Step 4: Download and Parse Each PDF

For each de-duplicated row:

1. Fetch the PDF from the `File_URL__c` value using WebFetch (the URL returns a PDF download)
2. Save the PDF locally to a temp path
3. Read the PDF using the Read tool to extract text

From each PDF, extract:

#### 4a: Referring / Interpreting Physician
Look for fields labeled "Referring Physician", "Interpreting Physician", "Ordering Provider",
"Referring Provider", or similar. Capture the full name and credentials (MD, DO, NP, APRN, etc.).

#### 4b: Organization / Location
Look for the physician's practice name, clinic, hospital, or health system. Also capture city/state
if visible. Check headers, footers, and letterhead areas of the PDF.

#### 4c: AHI Severity
Find the AHI (Apnea-Hypopnea Index) score. Classify it:
- **Mild**: AHI 5-14
- **Moderate**: AHI 15-29
- **Severe**: AHI 30+

This severity level informs the email tone — severe cases warrant more urgency language.

If any field cannot be found in the PDF, note it as "Not identified" and continue. Do not halt
the pipeline for a single missing field.

### Step 5: Research Physician and Find Email

For each physician identified in Step 4, follow this escalating lookup strategy. **Every
physician with enough identifying info (name + organization) MUST end this step with an email
address.** Do not stop at 5a or 5b — if Apollo returns no email, you MUST proceed to 5c and
infer one. The only acceptable `not_found` outcome is when the physician cannot be associated
with any identifiable organization at all.

#### 5a: Apollo.io Lookup (primary)
1. Use `apollo_people_match` with the physician's first name, last name, and organization name
2. Set `reveal_personal_emails: true` to maximize coverage
3. If Apollo returns an email, capture it along with title, location, and any additional context
4. If no email returned, CONTINUE to 5b and 5c — do not skip

#### 5b: Web Search Fallback (if Apollo has no email)
1. Use WebSearch to search for the physician's email: query like
   `"[Physician Name]" "[Organization]" email` or `"[Physician Name]" MD email [city] [state]`
2. Check the physician's practice website, health system directory, or professional profiles
3. Look for contact pages, provider directories, or "About Us" pages that list email addresses
4. Only use an email if it is an exact match — do not guess or use generic info@ addresses
5. If no exact-match email found, CONTINUE to 5c — do not skip

#### 5c: Email Pattern Inference (MANDATORY whenever 5a and 5b fail)
This step is REQUIRED for every physician who has an identifiable organization. Never leave a
prospect with `email_source: not_found` if you have an org name — infer the email instead.

1. Search Apollo for ANY person at the same organization who DOES have a verified email:
   - Use `apollo_mixed_people_api_search` with the organization name or domain
   - Or use `apollo_people_match` with a known colleague's name at that org
   - If the PDF itself contains a contact email at the same office (e.g. a clinic coordinator,
     office manager, front desk, or referring-back address), USE THAT as your colleague sample
2. Once you find a colleague's email (e.g., `jsmith@sleepcentername.com`), extract the
   email pattern: `{first_initial}{last}@domain`, `{first}.{last}@domain`, `{last}{first_initial}@domain`, etc.
3. Apply that same pattern to construct the target physician's email
4. Mark the email as `"email_source": "inferred"` in the JSON AND include `confidence`:
   - `"high"` — verified colleague email at exact same org/domain, clear pattern
   - `"medium"` — single colleague sample, or pattern plausible but unverified
   - `"low"` — domain guessed from org name (no colleague sample), standard convention
5. Also record the `source_colleague_name` and `source_colleague_email` so Dan can audit.

If no colleague can be found at the organization AND no PDF contact email exists, fall back to
the standard org-domain convention (`{first}.{last}@<orgdomain>` or `{first_initial}{last}@<orgdomain>`)
and mark confidence as "low". Every physician with an identifiable org must still get an inferred
email attempt.

#### Email Source Tracking
Always record how the email was obtained in the JSON output:
- `"email_source": "apollo"` — directly from Apollo enrichment
- `"email_source": "web_search"` — found via web search with exact match
- `"email_source": "inferred"` — constructed from a colleague's email pattern at same org
- `"email_source": "not_found"` — reserved ONLY for physicians with no identifiable organization
  (e.g. phone screenshots showing a physician name but no facility). Never use this as a shortcut.

### Step 6: Store Results in JSON

Save all collected data to a JSON file in the working directory:

**Filename**: `pre-d-prospects-YYYY-MM-DD.json` (using today's date)

**Structure**:
```json
{
  "run_date": "YYYY-MM-DD",
  "total_contacts": 0,
  "total_unique_contacts": 0,
  "total_unique_physicians": 0,
  "prospects": [
    {
      "contact_id": "003...",
      "contact_file_id": "a0a...",
      "created_date": "2026-04-06T...",
      "physician": {
        "name": "Dr. Jane Smith MD",
        "credentials": "MD",
        "role": "Interpreting Physician",
        "organization": "Springfield Sleep Center",
        "city": "Springfield",
        "state": "IL"
      },
      "ahi": {
        "score": 32.4,
        "severity": "Severe"
      },
      "apollo": {
        "email": "jsmith@springfieldsleep.com",
        "title": "Medical Director",
        "found": true
      },
      "email_draft_file": "Dr. Jane Smith MD - 2026-04-06.md"
    }
  ]
}
```

### Step 7: Draft Outreach Emails

For each physician with a valid email, draft a personalized introduction email.

Before drafting, read `references/Daybreak_Outreach_Prompt.md` (bundled in this skill folder) for
the complete copy rules, tone guidelines, structure, and examples. This file is the source of
truth for all email content decisions.

Key inputs to use when drafting:
- Physician name and credentials
- Their role (referring vs. interpreting)
- Organization name
- Location (city, state)
- AHI severity of the patient (informs urgency — severe = lean into faster treatment)
- Any Apollo context (specialty, health system affiliation, credentials)

The email should be a **first-touch cold email** designed for an Apollo.io sequence (Email 1 of 4).

### Step 8: Audit Against Outreach Rules

After drafting each email, audit it against `Daybreak_Outreach_Prompt.md`. Specifically check:

- Word count: body should be 150-200 words (excluding subject line and signature)
- Structure: subject line, opening hook, bridge, value bullets (3-4), contextual closer, CTA
- No banned phrases ("I hope this finds you well", "Just following up", etc.)
- No exclamation points, no emojis, no bold/underline
- First person singular ("I") in opening, "we" for Daybreak descriptions
- Subject line under 8 words, specific to doctor's context
- CTA asks for a brief call (15 minutes, quick call)
- Sign off as "Dan" — no last name, no title
- No PHI or patient names mentioned
- No pricing or insurance details

If any check fails, revise the email before saving.

### Step 9: Save Email Drafts

Save each email draft as a markdown file in the working directory:

**Filename**: `{Provider Name} - YYYY-MM-DD.md`

Example: `Dr. Jane Smith MD - 2026-04-06.md`

The file should contain:
```
**To:** {Physician Name}, {Organization}, {City} {State}
**Email:** {email from Apollo}
**AHI Context:** {severity} (AHI {score})

---

Subject: {subject line}

{email body}
```

### Step 10: Clean Up Downloaded PDFs

After all PDFs have been analyzed and all data has been extracted, delete every PDF and
converted image file that was downloaded during the pipeline run. These files contain PHI
and should not persist on disk.

```bash
rm -f "$USERPROFILE"/sleep_report_*.pdf "$USERPROFILE"/sr*_page*.jpg
```

Delete any other temp files created during the run (e.g., query files, intermediate JSON).
Do NOT delete the final output files (the prospects JSON and email draft markdown files).

### Step 11: Summary Report

After all emails are drafted, present a summary to the user:

- Total Contact_File__c records found today
- Unique contacts after de-duplication
- Unique physicians identified
- Emails drafted (with physician name + org)
- Physicians where email was not found (manual lookup needed)
- Physicians where PDF data was incomplete
- Path to the JSON file and email draft files

## Error Handling

- If the Salesforce query returns 0 results: report "No new sleep test results for today" and stop
- If a PDF cannot be downloaded: log the Contact ID and File URL, continue with next row
- If a PDF cannot be parsed: log it, continue
- If a page image exceeds the 2000px dimension limit (even after re-rendering at lower DPI):
  skip that image and continue. Never let a single oversized image cancel the pipeline run.
- If Apollo finds no email: include the physician in the JSON with `"found": false`, skip email draft
- If multiple rows map to the same physician: draft only one email, note all associated contacts

## De-duplication Note

De-duplicate physicians as well as contacts. If two different contacts have the same referring
physician, draft only one email to that physician but reference the volume pattern (multiple
patients referred) in the email copy.
