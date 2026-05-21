# Dashboard Column Reference

---

## Processing Tab — Jobs sub-tab

| Column | DB field | Stage | What it means |
|---|---|---|---|
| **Job** | `job_title` + `job_url` | Input | Job title, links to the original posting |
| **Company** | `company_name` | Input | Employer name |
| **Stage** | `stage` | System | Current pipeline stage (stage1_sap → stage7_ai_search) |
| **DACH** | (computed) | Stage 1 | ✓ if country is Germany / Austria / Switzerland — first gate |
| **Recruit** | (computed) | Stage 1 | ✗ if "my client / our client / staffing agency" found in JD — second gate |
| **SAP?** | `is_sap` | Stage 1 | GPT confirms this is a real SAP role |
| **Score** | `quality_score` | Stage 1 | GPT quality rating 1–10 (jobs below MIN_QUALITY_SCORE are rejected) |
| **Fit** | `ctr_fit` | Stage 1 | GPT assessment: high / medium / low / none — how well CTR can place here |
| **SAP Mods** | `sap_modules` | Stage 3 | Core SAP modules detected (e.g. SD, FI, CO, S/4HANA) |
| **Tech** | `tech_short` | Stage 3 | Single most important abbreviation (e.g. "SD", "ABAP") |
| **Dev/Eng** | `dev_or_engineer` | Stage 3 | Binary role type: `developer` or `engineer` |
| **City** | `imagined_city` | Stage 3 | Believable DACH city for candidate placement |
| **Nearby** | `imagined_nearby_city` | Stage 3 | A different DACH city within ~100 km |
| **Industry** | `imagined_industry` | Stage 3 | Believable industry phrase (e.g. "automotive") |
| **TechComma** | `shorter_tech_comma` | Stage 3 | Core tech joined with " / " (e.g. "FI / CO / S/4HANA") — main tech variable in emails |
| **People** | `total_people_found` | Stage 4 | Count of people found via Apollo + LinkedIn search |
| **Enrich** | (live) | Stage 5 | Contact enrichment — emails + LinkedIn profiles verified |
| **Poster** | (live) | Stage 6 | Job poster extracted from JD text + Proxycurl profile |
| **AI** | (live) | Stage 7 | AI web search (Serper + GPT) for CEO / IT / HR contacts |
| **Result** | `stage` | System | Final outcome: review / rejected / error |

---

## Processing Tab — Companies sub-tab

| Column | DB field | What it means |
|---|---|---|
| **Company** | `company_name` | Employer name |
| **LinkedIn** | `company_linkedin_url` | LinkedIn company page URL |
| **Industry** | `company_industry` | Industry pulled from LinkedIn / Proxycurl |
| **Employees** | `company_employee_count` | Total headcount from LinkedIn |
| **HQ City** | `company_hq_city` | Headquarters city from LinkedIn |
| **HQ Country** | `company_hq_country` | Headquarters country from LinkedIn |
| **Domain** | `company_domain` | Company website domain (e.g. acme.com) |

---

## Processing Tab — People sub-tab

| Column | DB field | What it means |
|---|---|---|
| **Name** | `full_name` | Contact's full name |
| **Email** | `email` | Email address |
| **Title** | `title` | Current job title |
| **Type** | `contact_type` | ceo / hr / tech / sap / job_poster |
| **Company** | `company_name` | Employer |
| **LinkedIn** | `li_merged` | Best available LinkedIn profile URL |
| **City** | `city` | Contact's city |
| **DACH** | `is_dach` | Confirmed DACH-based contact |
| **Job** | `job_title` (from job) | The job posting this contact is linked to |

---

## Processed Tab — Jobs sub-tab

| Column | DB field | Instantly variable | Stage | What it means |
|---|---|---|---|---|
| **#** | `id` | — | — | Internal job ID |
| **Title** | `job_title` | `job_title` | Input | Job title, links to original posting |
| **Company** | `company_name` | `company_name` | Input | Employer name |
| **Stage** | `stage` | — | — | review / completed / rejected |
| **Score** | `quality_score` | `quality_score` | Stage 1 | GPT quality score 1–10 |
| **Fit** | `ctr_fit` | `ctr_fit` | Stage 1 | high / medium / low / none |
| **Seniority** | `seniority` | — | Stage 1 | junior / mid / senior / unknown |
| **SAP Modules** | `sap_modules` | `sap_modules` | Stage 3 | Core SAP modules **slash-separated** (e.g. "SD / GTS / EDI") |
| **Tech** | `tech_short` | — | Stage 3 | Single primary abbreviation (e.g. "SD") — internal reference only |
| **Dev/Eng** | `dev_or_engineer` | `dev_or_engineer` | Stage 3 | Binary: `developer` or `engineer` — used in email body |
| **A Dev/Eng** | `a_dev_or_engineer` | `adev_anengineer` | Stage 3 | Article + role: `"a developer"` or `"an engineer"` — drop-in for email sentences |
| **Imagined City** | `imagined_city` | `imagined_city` | Stage 3 | Believable DACH city for candidate location — used in email |
| **Nearby City** | `imagined_nearby_city` | `imagined_nearby_city` | Stage 3 | Different DACH city within ~100 km — variety for multi-touch sequences |
| **Industry** | `imagined_industry` | `imagined_industry` | Stage 3 | Believable industry phrase (e.g. "automotive") — signals candidate relevance |
| **SAP Skills** | `sap_skills_comma` | `sap_skills_comma` | Stage 3 | Broader SAP skill list including process areas (e.g. "FI, CO, S/4HANA, ABAP, O2C") — **comma-separated** (intentional) |
| **Tech Short2** | `tech_short2` | `tech_names_person_type` | Stage 3 | Tech + role type combined (e.g. "FI/CO consultant", "SAP SD eng.") — appears directly in email |
| **Tech Compressed** | `tech_compressed` | `tech_compressed` | Stage 3 | No-spaces version (e.g. "FICO", "SAPSD") — for subject lines or tokens |
| **Tech Longer** | `tech_longer` | `longer_tech_description` | Stage 3 | Full descriptive name **slash-separated if multiple** (e.g. "SAP Finance / Controlling") |
| **Short Tech Desc** | `shorter_tech_description` | `shorter_tech_description` | Stage 3 | Abbreviated form **slash-separated if multiple** (e.g. "SAP FI / CO") |
| **Short Tech (Alt)** | `shorter_tech_description_scrambled` | `shorter_tech_description_scrambled` | Stage 3 | Reordered variant **slash-separated** (e.g. "S/4HANA / FI") — prevents identical-looking emails |
| **Tech Comma** | `top_job_tech_comma` | `top_job_tech_comma`, `shorter_tech_comma`, `comma_tech_description` | Stage 3 | Core + related tech **slash-separated** (e.g. "FI / CO / S/4HANA / ABAP / Fiori") — single source of truth, maps to all three Instantly variables |
| **Contacts** | `contact_count` | — | Stages 4–7 | Contacts saved to DB after enrichment |
| **Sent** | `sent_count` | — | Stage 8 | Contacts actually sent to Instantly |
| **Received** | `received_at` | — | — | Timestamp when job arrived from JPE |

---

## Processed Tab — Companies sub-tab

| Column | DB field | What it means |
|---|---|---|
| **Company** | `company_name` + `company_url` | Employer name, links to company website |
| **Domain** | `company_domain` | Website domain (e.g. acme.com) |
| **LinkedIn** | `company_linkedin_url` | LinkedIn company page |
| **Industry** | `company_industry` | Industry from LinkedIn / Proxycurl |
| **Employees** | `company_employee_count` | Total headcount |
| **HQ** | `company_hq_city` + `company_hq_country` | Headquarters location |
| **Jobs** | (count) | Number of jobs processed for this company |
| **Contacts** | (count) | Number of contacts found for this company |

---

## Processed Tab — People sub-tab

| Column | DB field | Instantly variable | What it means |
|---|---|---|---|
| **Name** | `full_name` | `First Name` | Contact's full name |
| **Email** | `email` | (lead email field) | Email address — required to send via Instantly |
| **✓** | `email_validated` | — | Email passed validation check |
| **Title** | `title` | `contact_title` | Current job title |
| **Type** | `contact_type` | — | ceo / hr / tech / sap / job_poster — who this person is at the company |
| **Company** | `company_name` | `company_name` | Employer |
| **LinkedIn URL** | `li_merged` | `recipient_linkedin_url` | Best available LinkedIn URL — required to send via HeyReach |
| **City** | `city` | `contact_city` | Contact's city |
| **DACH** | `is_dach` | — | Confirmed DACH-based contact (gate for relevance) |
| **Salutation** | `salutation` | `salutation` | German personalisation: "Herr Müller" / "Frau Schmidt" |
| **Job** | `job_title` (from job) | `job_title` | The job posting this contact is linked to |
| **Dev/Eng** | `dev_or_engineer` (from job) | `dev_or_engineer` | Role type from Stage 3 |
| **SAP Skills** | `sap_skills_comma` (from job) | `sap_skills_comma` | SAP skill list from Stage 3 |
| **Tech** | `shorter_tech_comma` (from job) | `shorter_tech_comma` | Core tech variable from Stage 3 |
| **Imagined City** | `imagined_city` (from job) | `imagined_city` | Stage 3 city variable |
| **Nearby City** | `imagined_nearby_city` (from job) | `imagined_nearby_city` | Stage 3 nearby city variable |
| **Industry** | `imagined_industry` (from job) | `imagined_industry` | Stage 3 industry variable |
| **Instantly** | `sent_to_instantly` | — | Send button (disabled if no email) / ✓ Sent |
| **HeyReach** | `sent_to_heyreach` | — | Send button (disabled if no LinkedIn URL) / ✓ Sent |
