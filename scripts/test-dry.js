#!/usr/bin/env node
/**
 * node scripts/test-dry.js
 *
 * Fully offline dry-run of the pipeline against 3 fake SAP jobs.
 * No DB, no API keys, no server needed.
 * All external service calls are mocked with realistic fake responses.
 *
 * Usage: node scripts/test-dry.js
 */

// ── Fake job data ──────────────────────────────────────────────────────────
const FAKE_JOBS = [
    {
        id:                   1,
        job_url:              'https://linkedin.com/jobs/view/test-001',
        job_title:            'SAP S/4HANA Finance Consultant (m/w/d)',
        job_description:      `Wir suchen einen erfahrenen SAP S/4HANA Berater im Bereich Finance & Controlling.
Aufgaben: Implementierung SAP FI/CO, Universal Journal, S/4HANA Migration.
Anforderungen: 5+ Jahre SAP FI/CO, S/4HANA Kenntnisse, fließend Deutsch.
Ansprechpartnerin: Anna Bergmann | anna.bergmann@is4it.de | HR Manager DACH.`,
        city:                 'Munich',
        country:              'Germany',
        company_url:          'https://www.is4it.de',
        company_linkedin_url: 'https://www.linkedin.com/company/is4it-de',
        company_name:         'IS4IT GmbH',
        job_poster_url:       null,
        source:               'LinkedIn jobs',
        stage:                'received',
        quality_score:        null,
        company_domain:       null,
        company_description:  null,
        company_employee_count: null,
        company_dach_employees: null,
        company_hq_city:      null,
        company_hq_country:   null,
        company_industry:     null,
    },
    {
        id:                   2,
        job_url:              'https://linkedin.com/jobs/view/test-002',
        job_title:            'SAP ABAP Senior Developer (m/w/d) – SAP S/4HANA Cloud',
        job_description:      `Für unser SAP Center of Excellence suchen wir einen Senior ABAP Entwickler.
Technologien: SAP ABAP OO, BTP, HANA DB, Clean Core, RAP Framework.
Einstieg direkt beim Kunden. Keine Personalvermittlung.
Ihr Ansprechpartner: Jörg Meier, Leiter SAP Development.`,
        city:                 'Berlin',
        country:              'Germany',
        company_url:          'https://www.sap-consulting-ag.de',
        company_linkedin_url: 'https://www.linkedin.com/company/sap-consulting-ag',
        company_name:         'SAP Consulting AG',
        job_poster_url:       'https://www.linkedin.com/in/joerg-meier-sap',
        source:               'LinkedIn jobs',
        stage:                'received',
        quality_score:        null,
        company_domain:       null,
        company_description:  null,
        company_employee_count: null,
        company_dach_employees: null,
        company_hq_city:      null,
        company_hq_country:   null,
        company_industry:     null,
    },
    {
        id:                   3,
        job_url:              'https://linkedin.com/jobs/view/test-003',
        job_title:            'SAP BTP Integration Architect (m/w/d)',
        job_description:      `CloudHero Solutions sucht SAP BTP Experten für Kundenprojekte in Wien.
Technologien: SAP Integration Suite, API Management, CAP Model, SAP HANA.
80% Remote möglich. Vollzeit. Start sofort.
Kein Personaldienstleister – Direktvermittlung.`,
        city:                 'Vienna',
        country:              'Austria',
        company_url:          'https://www.cloudhero.at',
        company_linkedin_url: 'https://www.linkedin.com/company/cloudhero-at',
        company_name:         'CloudHero Solutions GmbH',
        job_poster_url:       null,
        source:               'LinkedIn jobs',
        stage:                'received',
        quality_score:        null,
        company_domain:       null,
        company_description:  null,
        company_employee_count: null,
        company_dach_employees: null,
        company_hq_city:      null,
        company_hq_country:   null,
        company_industry:     null,
    },
];

// ── Mock service responses ─────────────────────────────────────────────────
const MOCKS = {
    openai: {
        sapCheck: (job) => ({
            is_sap:              true,
            is_direct_employer:  job.job_description.includes('Personalvermittlung') ? false : true,
            is_dach_confirmed:   true,
            quality_score:       job.job_title.includes('Senior') ? 8 : 7,
            seniority:           job.job_title.includes('Senior') ? 'senior' : 'mid',
            ctr_fit:             'high',
            rejection_reason:    null,
        }),
        techExtract: (job) => ({
            sap_modules:        job.job_title.includes('Finance') ? 'SAP FI, SAP CO, SAP S/4HANA Finance' : job.job_title.includes('ABAP') ? 'SAP ABAP, SAP BTP, SAP HANA' : 'SAP BTP, SAP Integration Suite, SAP HANA',
            sap_skills_comma:   job.job_title.includes('Finance') ? 'FI,CO,S/4HANA,Universal Journal' : job.job_title.includes('ABAP') ? 'ABAP,OO,RAP,Clean Core' : 'BTP,Integration Suite,CAP,API Management',
            tech_short:         job.job_title.includes('Finance') ? 'SAP FI/CO S/4HANA' : job.job_title.includes('ABAP') ? 'SAP ABAP BTP' : 'SAP BTP Integration',
            tech_short2:        'SAP S/4HANA',
            tech_compressed:    'SAP',
            tech_longer:        job.job_title.includes('Finance') ? 'SAP S/4HANA Finance & Controlling' : job.job_title.includes('ABAP') ? 'SAP ABAP & BTP Development' : 'SAP BTP Integration Architecture',
            top_job_tech_comma: 'SAP,S/4HANA,ABAP',
            primary_tech:       'SAP',
            dev_or_engineer:    job.job_title.includes('ABAP') || job.job_title.includes('Architect') ? 'Developer' : 'Consultant',
            a_dev_or_engineer:  job.job_title.includes('ABAP') || job.job_title.includes('Architect') ? 'a Developer' : 'a Consultant',
        }),
        jobPosterExtract: (job) => {
            if (job.job_description.includes('anna.bergmann@is4it.de'))
                return { found: true, full_name: 'Anna Bergmann', first_name: 'Anna', last_name: 'Bergmann', email: 'anna.bergmann@is4it.de', linkedin_url: null, title: 'HR Manager DACH', extraction_source: 'jd_text' };
            if (job.job_description.includes('Jörg Meier'))
                return { found: true, full_name: 'Jörg Meier', first_name: 'Jörg', last_name: 'Meier', email: null, linkedin_url: job.job_poster_url, title: 'Leiter SAP Development', extraction_source: 'both' };
            return { found: false, full_name: null, first_name: null, last_name: null, email: null, linkedin_url: null, title: null, extraction_source: 'none' };
        },
        gender: (firstName) => {
            const femaleNames = ['anna', 'maria', 'laura', 'julia', 'sarah', 'lisa'];
            const isFemale = femaleNames.some(n => firstName.toLowerCase().includes(n));
            const lastName = 'Bergmann';
            return isFemale
                ? { gender: 'female', salutation: 'Frau Bergmann' }
                : { gender: 'male',   salutation: `Herr ${lastName}` };
        },
    },
    proxycurl: {
        company: (liUrl) => ({
            name:                    liUrl.includes('is4it') ? 'IS4IT GmbH' : liUrl.includes('sap-consulting') ? 'SAP Consulting AG' : 'CloudHero Solutions GmbH',
            website:                 liUrl.includes('is4it') ? 'https://www.is4it.de' : liUrl.includes('sap-consulting') ? 'https://www.sap-consulting-ag.de' : 'https://www.cloudhero.at',
            description:             'Leading SAP consulting partner specialising in S/4HANA transformations and cloud migrations.',
            industry:                'Information Technology & Services',
            company_size_on_linkedin: liUrl.includes('is4it') ? 350 : liUrl.includes('sap-consulting') ? 1200 : 80,
            hq:                      { city: liUrl.includes('is4it') ? 'Munich' : liUrl.includes('sap-consulting') ? 'Berlin' : 'Vienna', country: liUrl.includes('cloudhero') ? 'Austria' : 'Germany' },
        }),
        person: (liUrl) => ({
            first_name:          'Jörg',
            last_name:           'Meier',
            full_name:           'Jörg Meier',
            occupation:          'Head of SAP Development',
            city:                'Berlin',
            country_full_name:   'Germany',
            public_identifier:   'joerg-meier-sap',
        }),
    },
    apollo: {
        searchPeople: () => ([
            { id: 'apo-1', first_name: 'Klaus', last_name: 'Weber',  title: 'CEO',         email: 'k.weber@company.de',   linkedin_url: 'https://linkedin.com/in/klausweber' },
            { id: 'apo-2', first_name: 'Sandra', last_name: 'Koch', title: 'HR Director',  email: 's.koch@company.de',    linkedin_url: 'https://linkedin.com/in/sandrakoch' },
            { id: 'apo-3', first_name: 'Markus', last_name: 'Braun', title: 'CTO',         email: 'm.braun@company.de',   linkedin_url: 'https://linkedin.com/in/markusbraun' },
            { id: 'apo-4', first_name: 'Elena',  last_name: 'Müller', title: 'SAP Lead',   email: 'e.mueller@company.de', linkedin_url: 'https://linkedin.com/in/elenmueller' },
        ]),
        enrichPerson: () => ({ email: 'joerg.meier@sap-consulting-ag.de' }),
    },
    apify: {
        scrapeWebsite: () => `IS4IT GmbH - SAP Partner\n\nWir sind ein führendes SAP-Beratungsunternehmen mit Schwerpunkt auf S/4HANA Transformationen.\nStandorte: München, Frankfurt, Wien\nMitarbeiter: ca. 350 weltweit, davon 280 im DACH-Raum.`,
    },
};

// ── Simple chalk-like colours (no dependencies) ───────────────────────────
const C = {
    bold:   s => `\x1b[1m${s}\x1b[0m`,
    dim:    s => `\x1b[2m${s}\x1b[0m`,
    green:  s => `\x1b[32m${s}\x1b[0m`,
    red:    s => `\x1b[31m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    cyan:   s => `\x1b[36m${s}\x1b[0m`,
    blue:   s => `\x1b[34m${s}\x1b[0m`,
    white:  s => `\x1b[37m${s}\x1b[0m`,
};

function header(title) {
    console.log('');
    console.log(C.bold(C.cyan('  ══ ' + title + ' ══')));
}
function ok(msg)   { console.log(C.green('  ✓ ') + msg); }
function info(msg) { console.log(C.dim('    ') + msg); }
function warn(msg) { console.log(C.yellow('  ! ') + msg); }
function field(k, v) { console.log(C.dim('    ') + C.dim(k.padEnd(26)) + C.white(String(v ?? '—'))); }
function sep()     { console.log(C.dim('  ' + '─'.repeat(60))); }

// ── Stage runners (offline, using MOCKS) ──────────────────────────────────

function runStage01(job) {
    header(`Job #${job.id} — Stage 1: SAP Check`);
    const result = MOCKS.openai.sapCheck(job);

    const isDACH = ['germany','austria','switzerland'].some(c => (job.country||'').toLowerCase().includes(c));
    field('country',          job.country);
    field('is_dach',          isDACH ? C.green('yes') : C.red('NO — would reject'));
    field('is_sap',           result.is_sap ? C.green('yes') : C.red('NO'));
    field('is_direct_employer', result.is_direct_employer ? C.green('yes') : C.yellow('no (recruiter signal)'));
    field('quality_score',    result.quality_score + '/10');
    field('seniority',        result.seniority);
    field('ctr_fit',          result.ctr_fit);

    if (!isDACH || !result.is_sap) {
        warn('Job would be REJECTED at Stage 1');
        return null;
    }
    ok('Stage 1 passed');
    return { ...job, ...result };
}

function runStage02(job) {
    header(`Job #${job.id} — Stage 2: Company Enrichment`);

    const liData    = MOCKS.proxycurl.company(job.company_linkedin_url);
    const apifyText = MOCKS.apify.scrapeWebsite(job.company_url);
    const domain    = new URL(job.company_url).hostname.replace(/^www\./,'');

    const dach_offices = apifyText.includes('Wien') ? ['Munich','Frankfurt','Vienna'] : ['Munich','Frankfurt'];

    field('company_domain',      domain);
    field('company_industry',    liData.industry);
    field('employee_count',      liData.company_size_on_linkedin);
    field('hq_city',             liData.hq.city);
    field('hq_country',          liData.hq.country);
    field('dach_offices',        dach_offices.join(', '));
    field('dach_employees',      Math.round(liData.company_size_on_linkedin * 0.8));
    field('description_snippet', liData.description.slice(0, 60) + '…');
    field('[apify]',             C.dim(apifyText.slice(0, 70) + '…'));

    ok('Stage 2 passed');
    return {
        ...job,
        company_domain:          domain,
        company_description:     liData.description,
        company_employee_count:  liData.company_size_on_linkedin,
        company_dach_employees:  Math.round(liData.company_size_on_linkedin * 0.8),
        company_hq_city:         liData.hq.city,
        company_hq_country:      liData.hq.country,
        company_industry:        liData.industry,
    };
}

function runStage03(job) {
    header(`Job #${job.id} — Stage 3: Tech Extract`);
    const result = MOCKS.openai.techExtract(job);

    field('sap_modules',        result.sap_modules);
    field('sap_skills_comma',   result.sap_skills_comma);
    field('tech_short',         result.tech_short);
    field('tech_short2',        result.tech_short2);
    field('tech_longer',        result.tech_longer);
    field('primary_tech',       result.primary_tech);
    field('dev_or_engineer',    result.dev_or_engineer);
    field('a_dev_or_engineer',  result.a_dev_or_engineer);

    ok('Stage 3 passed');
    return { ...job, ...result };
}

function runStage04(job) {
    header(`Job #${job.id} — Stage 4: Find People`);

    const people = MOCKS.apollo.searchPeople();
    console.log(`  ${C.cyan(people.length)} contacts found via Apollo:`);
    for (const p of people) {
        info(`${p.first_name} ${p.last_name} — ${p.title} — ${p.email}`);
    }

    ok('Stage 4 passed');
    return { ...job, _contacts_found: people };
}

function runStage05(job) {
    header(`Job #${job.id} — Stage 5: Enrich Contacts`);

    const people = job._contacts_found || [];
    console.log(`  Enriching ${people.length} contacts:`);
    for (const p of people) {
        const isDACH = true; // Germany assumed
        const gen = MOCKS.openai.gender(p.first_name);
        info(`${p.first_name} ${p.last_name} | ${p.email} | ${gen.salutation} | DACH: ${isDACH ? 'yes' : 'no'}`);
    }

    ok('Stage 5 passed');
    return job;
}

function runStage06(job) {
    header(`Job #${job.id} — Stage 6: Job Poster`);

    const extracted = MOCKS.openai.jobPosterExtract(job);
    field('extraction_source', extracted.extraction_source);
    field('found',             extracted.found ? C.green('yes') : C.dim('no'));

    if (!extracted.found) {
        warn('No job poster found in JD — skipping');
        return job;
    }

    field('full_name',  extracted.full_name);
    field('title',      extracted.title);
    field('email (JD)', extracted.email || C.dim('not in JD'));

    let email = extracted.email;
    if (!email && job.job_poster_url) {
        const enriched = MOCKS.apollo.enrichPerson();
        email = enriched.email;
        field('email (Apollo)', email);
    }
    if (!email) {
        field('email (Apollo)', C.dim('not found'));
    }

    if (job.job_poster_url) {
        const profile = MOCKS.proxycurl.person(job.job_poster_url);
        field('proxycurl name',  profile.full_name);
        field('proxycurl title', profile.occupation);
    }

    const gen = extracted.first_name ? MOCKS.openai.gender(extracted.first_name) : { gender: 'unknown', salutation: extracted.full_name || '' };
    field('gender',     gen.gender);
    field('salutation', gen.salutation);

    ok(`Stage 6 — poster saved: ${extracted.full_name} | email: ${email || '—'} | salutation: ${gen.salutation}`);
    return job;
}

function runStage07(job) {
    header(`Job #${job.id} — Stage 7: AI Contact Search`);

    // Simulate GPT web search results for CEO, IT, HR
    const ceoResult = `First Name: Klaus\nLast Name: Weber\nTitle: CEO\nLinkedIn URL: https://linkedin.com/in/klausweber\nCity: ${job.city}\nCountry: ${job.country}`;
    const itResult  = `First Name: Markus\nLast Name: Braun\nTitle: CTO\nLinkedIn URL: https://linkedin.com/in/markusbraun\nCity: ${job.city}\nCountry: ${job.country}`;
    const hrResult  = `First Name: Sandra\nLast Name: Koch\nTitle: HR Director\nLinkedIn URL: https://linkedin.com/in/sandrakoch\nCity: ${job.city}\nCountry: ${job.country}`;

    info('[SEARCH CEO]  → ' + ceoResult.split('\n')[0] + ', ' + ceoResult.split('\n')[1]);
    info('[ENSURE CEO]  → verified, writing to contacts');
    info('[SEARCH IT]   → ' + itResult.split('\n')[0] + ', ' + itResult.split('\n')[1]);
    info('[ENSURE IT]   → verified, writing to contacts');
    info('[SEARCH HR]   → ' + hrResult.split('\n')[0] + ', ' + hrResult.split('\n')[1]);
    info('[ENSURE HR]   → verified, writing to contacts');

    ok('Stage 7 passed — 3 AI contacts found');
    return job;
}

function runStage08(job) {
    header(`Job #${job.id} — Stage 8: Send to Instantly`);

    const contacts = [
        { full_name: 'Klaus Weber',   email: 'k.weber@' + job.company_domain, type: 'ceo',        salutation: 'Herr Weber' },
        { full_name: 'Markus Braun',  email: 'm.braun@' + job.company_domain, type: 'tech',       salutation: 'Herr Braun' },
        { full_name: 'Sandra Koch',   email: 's.koch@'  + job.company_domain, type: 'hr',         salutation: 'Frau Koch' },
        { full_name: job.job_description.includes('anna.bergmann') ? 'Anna Bergmann' : 'Job Poster', email: job.job_description.includes('anna.bergmann') ? 'anna.bergmann@is4it.de' : null, type: 'job_poster', salutation: 'Frau Bergmann' },
    ].filter(c => c.email);

    console.log(`  ${C.cyan(contacts.length)} contacts to send:`);
    for (const c of contacts) {
        info(`${C.dim('[' + c.type.padEnd(12) + ']')}  ${c.email}  →  salutation: "${c.salutation}"`);
        info(`  variables: job_title=${job.job_title.slice(0,30)}… | sap_modules=${job.sap_modules?.split(',')[0]}… | score=${job.quality_score}`);
    }

    ok(`Stage 8 passed — ${contacts.length} leads sent to Instantly`);
    return { ...job, stage: 'completed' };
}

// ── Main runner ────────────────────────────────────────────────────────────
async function main() {
    console.log('');
    console.log(C.bold('  claude-jpe — Dry Run Test (no DB, no API keys)'));
    console.log(C.dim('  ─────────────────────────────────────────────────────────────'));

    const totalContacts = { sent: 0, rejected: 0 };

    for (const rawJob of FAKE_JOBS) {
        sep();
        console.log('');
        console.log(C.bold(`  JOB #${rawJob.id}: ${rawJob.job_title}`));
        console.log(C.dim(`  Company : ${rawJob.company_name}  |  ${rawJob.city}, ${rawJob.country}`));
        console.log('');

        let job = rawJob;

        job = runStage01(job);
        if (!job) { totalContacts.rejected++; continue; }

        job = runStage02(job);
        job = runStage03(job);
        job = runStage04(job);
        job = runStage05(job);
        job = runStage06(job);
        job = runStage07(job);
        job = runStage08(job);

        console.log('');
        console.log(C.green(C.bold(`  ✓ Job #${rawJob.id} COMPLETED — stage: ${job.stage}`)));
        totalContacts.sent += 4;
    }

    sep();
    console.log('');
    console.log(C.bold('  Dry Run Summary'));
    console.log(C.dim('  ─────────────────────────────────────────────────────────────'));
    console.log(`  Jobs processed : ${C.cyan(FAKE_JOBS.length)}`);
    console.log(`  Jobs rejected  : ${C.yellow(totalContacts.rejected)}`);
    console.log(`  Completed      : ${C.green(FAKE_JOBS.length - totalContacts.rejected)}`);
    console.log(`  Contacts sent  : ${C.cyan(totalContacts.sent)} (estimated)`);
    console.log('');
    console.log(C.dim('  This was a DRY RUN — no DB writes, no API calls, no Instantly sends.'));
    console.log(C.dim('  To run for real: fill .env, npm run migrate, npm run seed, npm run pipeline'));
    console.log('');
}

main().catch(err => {
    console.error('\x1b[31m  Error: ' + err.message + '\x1b[0m');
    process.exit(1);
});
