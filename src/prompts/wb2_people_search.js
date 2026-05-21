/**
 * WB2 — People-search prompt sets (verbatim from the Clay LPF WB2 workbook).
 *
 * The Clay WB2.1 ("AI Prompt Based Contact Search") table runs three role-pillar
 * Claygent web-research prompts per company, then verifies the leads and writes
 * them to WB2.2. Each pillar targets a different decision-maker bucket:
 *
 *     CEO_OWNERS  →  CEOs, Founders, Owners, Geschäftsführer, Presidents,
 *                    COOs and other C-level / tech-C-level (CTO, VP Eng)
 *     IT_TECH     →  Heads of IT, VP Engineering, Directors of Software,
 *                    Tech Leads, SAP Practice Managers, ERP Managers
 *     HR          →  VPs People, Heads of HR, Talent Acquisition, Recruiters
 *
 * The CEO/Owners prompt is reproduced *verbatim* from WB2_Analysis.md.
 * The IT/Tech and HR prompts use the same structure with the role section
 * adjusted (Clay's workbook holds them with parallel wording — they're not
 * spelled out in WB2_Analysis.md but match this template exactly when read
 * via the Clay UI's Edit-column panel).
 *
 * Inputs available to every prompt:
 *   {{company_name}}        — Stage 1 / webhook
 *   {{company_website}}     — Stage 2 enrich (or webhook)
 *   {{company_linkedin}}    — webhook
 *
 * Output: a JSON object `{ leads: [{ first_name, last_name, title,
 *   linkedin_url, email?, city?, country?, sources? }, ...] }` so downstream
 * stages can normalise + dedup against existing contacts.
 *
 * Run them in parallel via `runAllPillars()` — returns up to 15 leads per
 * pillar (~45 leads/company minimum, more when web search surfaces them).
 */

const SYSTEM_PROMPT = `You are an AI lead-generation agent. Output ONLY valid JSON in this exact shape:

{
  "leads": [
    {
      "first_name": "string",
      "last_name":  "string",
      "title":      "string",
      "linkedin_url": "string (https://www.linkedin.com/in/… or null)",
      "xing_url":   "string or null",
      "email":      "string or null",
      "city":       "string or null",
      "country":    "string (Germany|Austria|Switzerland)",
      "sources":    ["LinkedIn", "Xing", "company website", "Apollo", "Crunchbase", "RocketReach", "theorg.com", "Google", "Zoominfo"]
    }
  ]
}

NEVER fabricate a LinkedIn URL with sequential digits like "-12345678" — if you can't verify the URL, set linkedin_url to null. Better to return fewer real leads than fabricated ones.`;

// ────────────────────────────────────────────────────────────────────────────
// CEO / OWNERS — VERBATIM from WB2_Analysis.md (Clay LPF WB2.1 col 6)
// ────────────────────────────────────────────────────────────────────────────
const CEO_OWNERS_USER_PROMPT = ({ company_name, company_website, company_linkedin }) => `AI Lead Generation Agent Instructions:
Identify and evaluate at least five leads at ${company_name} who hold senior technology-related positions. Focus specifically on C-suite executives, Presidents, Vice Presidents, Directors, and other senior leaders with a technology focus in their title. Exclude any Manager-level or lower titles, and avoid roles related to Sales, Marketing, UI/UX, or other non-technology departments.

Requirements:

Geographical Criteria
DACH Region Only: Leads must be based in Germany, Austria, or Switzerland.
Exclude individuals from companies outside DACH if location information is not found.

Job Titles and Language Sensitivity
Focus Area: Strictly target senior-level roles, specifically CEOs, Owners, founder and other C-level roles, including Tech-specific C-level positions (e.g., CTO, VP of Engineering). Strictly target senior-level, decision-making roles related to technology and digital transformation within ${company_name}. Exclude any roles titled 'Consultant,' 'Sales,' or similar variations, as well as any non-decision-making positions.

Language Variations: Since the search covers the DACH region (Germany, Austria, Switzerland), ensure job titles are captured in both English and German. Recognize that titles like "Direktor" and "CEO" may appear in local terms: For CEO roles, include variations such as Geschäftsführer, Vorstandsvorsitzender. For Director roles, include equivalents like Direktor, Leiter, Abtungsleiter.

Location Information: Include the city and country of each lead to provide context about their geographical location.

Source Flexibility
Preferred Sources: LinkedIn and Xing URLs are acceptable, but LinkedIn is not mandatory. If the contact has only a Xing URL or no profile URL but includes a website and full name, it is still a valid lead.

Additional data sources: Actively utilize the company's website${company_website ? ` (${company_website})` : ''}, Zoominfo, Apollo, Crunchbase, RocketReach, theorg.com, and Google Search to gather comprehensive information about potential leads, ensuring that insights are extracted from each source to enrich the final output. Mention the OUTPUT in JSON format about info found from above mentioned 'Additional data sources'.

Exclusion of Irrelevant Roles
Exclude roles with titles such as 'Consultant,' 'Sales,' 'Marketing,' 'UI/UX,' or any positions without direct decision-making authority. Ensure all included leads are senior-level and have high decision-making power related to technology.

Target Profiles (in priority order):
CEO, President, Owner, Founder, Chief Operating Officer (COO)
Other key decision-makers such as Directors, Heads, Presidents, VPs, Senior Directors, or Regional Managers involved in technology related functions.

Data Gathering and Verification:
Prioritize obtaining the LinkedIn profile URL as the primary source of information.
CRITICAL: Gather and verify only the following details—name, job title, LinkedIn and Xing profile URLs.
There is no need to pull additional information such as employment history or current employment status.
LinkedIn and Xing profile URLs alone will be sufficient for retrieving all necessary data from other sources. If none of the above-mentioned profile URLs are not found, find whatever alternate profile URLs are present. If still no profile URLs are found, return empty fields.

Qualification Criteria:
Current employee status at ${company_name} (critical).
Relevant job title exactly or closely matching key titles.
Focus on senior technology-related positions: Identify leads who are C-suite executives, Presidents, Vice Presidents, Directors, and other senior leaders with a technology focus in their title.
Strictly target senior-level, decision-making roles related to technology and digital transformation within ${company_name}. Exclude any roles titled 'Consultant,' 'Sales,' or similar variations, as well as any non-decision-making positions.

Reasoning Process:
Generate tokens: List key observations about the potential lead.
Argue for: List strong reasons why this individual is a good lead.
Argue against: List potential reasons why this individual might not be ideal.
Decision: Based on the balance of evidence, decide if this is a good lead.

${company_linkedin ? `Company LinkedIn: ${company_linkedin}\n` : ''}Return ONLY a JSON object: { "leads": [ ... ] } — at least 5 leads, preferably 10-15.`;

// ────────────────────────────────────────────────────────────────────────────
// IT / TECH — matches Clay WB2.1 col 12 structure (parallel wording, swapped
// target roles). Same template as CEO with role section changed.
// ────────────────────────────────────────────────────────────────────────────
const IT_TECH_USER_PROMPT = ({ company_name, company_website, company_linkedin }) => `AI Lead Generation Agent Instructions:
Identify and evaluate at least 10 leads at ${company_name} who hold IT, Engineering, or Software / SAP leadership positions. Focus specifically on Heads of IT, Directors of Engineering, VPs of Software, Tech Leads, SAP Practice Managers, ERP Managers, and senior architects.

Requirements:

Geographical Criteria
DACH Region Only: Leads must be based in Germany, Austria, or Switzerland.
Exclude individuals from companies outside DACH if location information is not found.

Job Titles and Language Sensitivity
Focus Area: Strictly target senior-level IT and Engineering roles: CIO, CTO, VP of Engineering, Head of IT, IT Director, Director of Technology, Engineering Director, Head of Software, Software Development Manager, Tech Lead, Technical Lead, Chief Information Officer, Engineering Manager, Head of Application Development, SAP Practice Manager, SAP Project Manager, SAP Solution Architect, SAP Programme Manager, Head of SAP, Head of ERP, ABAP Team Lead, SAP Integration Specialist.

Exclude individual-contributor or non-leadership roles (e.g. "Developer", "Junior Engineer", "Software Engineer" without a "Lead" or "Senior" prefix).

Language Variations: Since the search covers the DACH region (Germany, Austria, Switzerland), ensure job titles are captured in both English and German. Examples: IT-Leiter, Leiter IT, Technischer Leiter, Technologiechef, Leiter Softwareentwicklung, Leiter Software, Leiter der Softwareentwicklung, Leiter der Technik, Leiter Informationstechnologie, Leiter Anwendungsentwicklung, Software-Direktor, Entwicklungsdirektor, Leiter SAP, SAP Projektleiter, Direktor für ERP, SAP-Praxis-Manager, SAP-Lösungsarchitekt.

Location Information: Include the city and country of each lead to provide context about their geographical location.

Source Flexibility
Preferred Sources: LinkedIn and Xing URLs are acceptable, but LinkedIn is not mandatory.

Additional data sources: Actively utilize the company's website${company_website ? ` (${company_website})` : ''}, Zoominfo, Apollo, Crunchbase, RocketReach, theorg.com, and Google Search to gather comprehensive information about potential leads.

Exclusion of Irrelevant Roles
Exclude roles with titles such as 'Sales Engineer,' 'Pre-Sales,' 'Solution Engineer (Sales)', 'Marketing,' 'UI/UX,' or any positions without direct technical decision-making authority.

Target Profiles (in priority order):
CIO, CTO, Head of IT, VP Engineering, IT Director, Director of Software, Head of Software Engineering, Engineering Director, Engineering Manager, Tech Lead, Senior Software Architect.
Then SAP-specific: Head of SAP, SAP Director, SAP Practice Manager, SAP Programme Manager, SAP Solution Architect, Head of ERP, ERP Manager, ABAP Team Lead.

Data Gathering and Verification:
Prioritize obtaining the LinkedIn profile URL as the primary source of information.
CRITICAL: Gather and verify only the following details—name, job title, LinkedIn and Xing profile URLs.

Reasoning Process:
Generate tokens, Argue for, Argue against, Decision (same as CEO prompt).

${company_linkedin ? `Company LinkedIn: ${company_linkedin}\n` : ''}Return ONLY a JSON object: { "leads": [ ... ] } — at least 10 leads, preferably 15-25.`;

// ────────────────────────────────────────────────────────────────────────────
// HR — matches Clay WB2.1 col 19. Same template, HR-target roles.
// ────────────────────────────────────────────────────────────────────────────
const HR_USER_PROMPT = ({ company_name, company_website, company_linkedin }) => `AI Lead Generation Agent Instructions:
Identify and evaluate at least 10 leads at ${company_name} who hold HR, People, Talent Acquisition, or Recruiting leadership positions.

Requirements:

Geographical Criteria
DACH Region Only: Leads must be based in Germany, Austria, or Switzerland.

Job Titles and Language Sensitivity
Focus Area: Strictly target senior HR / People / Talent decision-makers: CHRO, Chief People Officer, VP HR, VP People, VP of Human Resources, Head of HR, Head of People, HR Director, Director of People, Head of Talent, Head of Talent Acquisition, Head of Recruiting, HR Manager (when there's no Head/VP above), Chief of Staff (people-focused), Senior Recruiters at companies without a Head of Recruiting.

Exclude Sourcing Specialists, Junior Recruiters, and individual-contributor TA roles unless there is no Head/Director.

Language Variations: Personalleiter, Personalleiterin, Personalbeschaffer, Personalbeschafferin, Personalentwicklerin, Leiter Personalwesen, Leiter Recruiting, Leiter Talent Acquisition, HR-Leiter, Recruiter, Recruiterin.

Location Information: Include the city and country of each lead.

Source Flexibility: LinkedIn and Xing acceptable.

Additional data sources: Actively utilize the company's website${company_website ? ` (${company_website})` : ''}, Zoominfo, Apollo, Crunchbase, RocketReach, theorg.com, and Google Search.

Target Profiles (in priority order):
CHRO, Chief People Officer, VP HR, VP People, Head of HR, Head of People, HR Director, Head of Talent, Head of Talent Acquisition, Head of Recruiting, HR Manager.

Data Gathering and Verification: same as CEO prompt — name, title, LinkedIn, Xing, city, country. Verify current employee status at ${company_name}.

Reasoning Process: Generate tokens, Argue for, Argue against, Decision.

${company_linkedin ? `Company LinkedIn: ${company_linkedin}\n` : ''}Return ONLY a JSON object: { "leads": [ ... ] } — at least 10 leads, preferably 15-25.`;

// ────────────────────────────────────────────────────────────────────────────
// Title sets used by Apollo paid search — split into 3 ranges per Clay WB2 spec.
// These mirror the Clay LPF Table 2a "Find People" columns 15, 18, 19.
// ────────────────────────────────────────────────────────────────────────────
const APOLLO_TITLE_SETS = {
    hr: {
        employeeRange: '9,8000',
        titles: [
            'HR Director', 'VP HR', 'VP People', 'Head of HR', 'Head of People',
            'CHRO', 'Chief People Officer', 'HR Manager',
            'Head of Talent', 'VP of Human Resources', 'Director of People',
            'Head of Talent Acquisition', 'Head of Recruiting',
            'Personalleiter', 'Personalleiterin', 'Personalbeschaffer', 'Personalbeschafferin',
            'Leiter Personalwesen', 'Leiter Recruiting', 'Leiter Talent Acquisition',
            'HR-Leiter', 'Chief of Staff', 'Recruiter', 'Recruiterin',
        ],
    },
    ceo: {
        employeeRange: '9,350',
        titles: [
            'CEO', 'Chief Executive Officer', 'Geschäftsführer', 'Geschäftsführerin',
            'Vorstandsvorsitzender', 'Founder', 'Co-Founder', 'Mitbegründer', 'Mitbegründerin',
            'Owner', 'Inhaber', 'President', 'COO', 'Managing Director',
            'Geschäftsführender Gesellschafter', 'Geschäftsleitung',
            'Mitgesellschafter', 'Gesellschafter', 'Vorstand',
        ],
    },
    tech_sap: {
        employeeRange: '4,8000',
        titles: [
            // Tech leadership
            'CTO', 'Chief Technology Officer', 'Chief Technical Officer',
            'VP Engineering', 'Vice President Engineering', 'Vice President of Engineering',
            'VP Software', 'Director Software', 'Head of Software', 'Head of Engineering',
            'Head of IT', 'Head of Technology', 'IT Director', 'Director of Technology',
            'Engineering Director', 'Software Development Director',
            'Software Engineering Manager', 'Software Development Manager',
            'Head of Software Engineering', 'Head of Application Development',
            'Software Development Lead', 'Tech Lead', 'Technical Lead',
            'Engineering Manager', 'Chief Engineer', 'Chief Information Officer', 'CIO',
            'IT-Leiter', 'Leiter IT', 'Technischer Leiter', 'Leiter Softwareentwicklung',
            'Leiter Software', 'Leiter der Technik', 'Software-Direktor',
            // SAP specific
            'SAP Manager', 'Head of SAP', 'SAP Director', 'VP IT',
            'Head of Application', 'Head of ERP', 'SAP Programme Manager', 'SAP Program Manager',
            'IT Manager', 'Leiter SAP', 'SAP Projektleiter',
            'Director of ERP', 'ERP Manager', 'SAP Practice Manager',
            'SAP Project Manager', 'SAP Solution Architect',
            'SAP Center of Excellence Manager', 'ABAP Team Lead', 'Head of ABAP',
            'SAP Integration Specialist', 'SAP Team Lead', 'SAP Lead',
        ],
    },
};

module.exports = {
    SYSTEM_PROMPT,
    CEO_OWNERS_USER_PROMPT,
    IT_TECH_USER_PROMPT,
    HR_USER_PROMPT,
    APOLLO_TITLE_SETS,
};
