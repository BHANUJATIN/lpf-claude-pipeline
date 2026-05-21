#!/usr/bin/env node
/**
 * node scripts/seed.js
 *
 * Inserts 3 realistic fake SAP jobs for testing the pipeline.
 * Covers 3 scenarios:
 *   Job 1 — SAP S/4HANA consultant role, job poster email in JD, company LinkedIn URL
 *   Job 2 — SAP FI/CO role, job poster LinkedIn URL from JPE, no email in JD
 *   Job 3 — SAP BTP/Cloud role, no poster info at all, Austrian company
 */
require('dotenv').config();
const chalk    = require('chalk');
const Database = require('../src/database/Database');
const DatabaseService = require('../src/database/DatabaseService');

const JOBS = [
    {
        job_url:              'https://www.linkedin.com/jobs/view/test-sap-s4-munich-001',
        job_title:            'SAP S/4HANA Consultant (m/w/d) – Finance & Controlling',
        job_description: `Zur Verstärkung unseres Teams suchen wir einen erfahrenen SAP S/4HANA Berater im Bereich Finance & Controlling.

Ihre Aufgaben:
• Implementierung und Customizing von SAP S/4HANA Finance (FI/CO)
• Analyse und Optimierung von Geschäftsprozessen
• Projektleitung und Betreuung von SAP-Einführungsprojekten
• Mitarbeit bei S/4HANA Migrationen (Brownfield / Greenfield)

Ihr Profil:
• Mehrjährige Erfahrung im SAP FI/CO Umfeld
• Kenntnisse in SAP S/4HANA, idealerweise Universal Journal
• Deutsch fließend, Englisch gut

Bei Fragen wenden Sie sich direkt an unsere Personalreferentin:
Anna Bergmann | anna.bergmann@is4it.de | HR Manager DACH

Wir freuen uns auf Ihre Bewerbung!`,
        city:                 'Munich',
        country:              'Germany',
        company_url:          'https://www.is4it.de',
        company_linkedin_url: 'https://www.linkedin.com/company/is4it-de',
        company_name:         'IS4IT GmbH',
        job_poster_url:       null,
        source:               'LinkedIn jobs',
        applicant_count:      '34 applicants',
        search_term:          'SAP S/4HANA Consultant',
    },
    {
        job_url:              'https://www.linkedin.com/jobs/view/test-sap-fi-frankfurt-002',
        job_title:            'Senior SAP FI/CO Berater (m/w/d) Direktvermittlung',
        job_description: `Für unseren Kunden, ein führendes Unternehmen im Bereich Fertigungsindustrie mit Sitz in Frankfurt, suchen wir ab sofort einen Senior SAP FI/CO Berater.

Aufgaben:
• Verantwortung für SAP FI/CO Module in einem internationalen SAP-Projekt
• Customizing und Weiterentwicklung bestehender SAP-Landschaften
• Zusammenarbeit mit internen Fachabteilungen und externen Beratern
• Vorbereitung und Durchführung von User Acceptance Tests (UAT)

Anforderungen:
• Mind. 5 Jahre SAP FI/CO Erfahrung, davon 2 Jahre in S/4HANA
• Erfahrung in der Direktvermittlung von Vorteil
• ABAP Grundkenntnisse wünschenswert

Direkteinstieg – keine Zeitarbeit, keine Arbeitnehmerüberlassung!

Diese Stelle wird betreut von: Thomas Richter (SAP Recruiting)`,
        city:                 'Frankfurt am Main',
        country:              'Germany',
        company_url:          'https://www.agileco.de',
        company_linkedin_url: 'https://www.linkedin.com/company/agileco',
        company_name:         'Agileco GmbH',
        job_poster_url:       'https://www.linkedin.com/in/thomas-richter-sap',
        source:               'LinkedIn jobs',
        applicant_count:      '12 applicants',
        search_term:          'SAP FI/CO Berater',
    },
    {
        job_url:              'https://www.linkedin.com/jobs/view/test-sap-btp-vienna-003',
        job_title:            'SAP BTP & Integration Architect (m/w/d)',
        job_description: `Ein innovatives Softwareunternehmen im Herzen Wiens sucht einen erfahrenen SAP BTP Architekten zur Verstärkung des Cloud-Kompetenzzentrums.

Ihr Aufgabengebiet:
• Architektur und Implementierung von Lösungen auf der SAP Business Technology Platform (BTP)
• Integration von On-Premise SAP-Systemen mit Cloud-Lösungen (SAP Integration Suite, API Management)
• Entwicklung von SAP Extension Suite Anwendungen (CAP, Fiori Elements)
• Technische Beratung bei der S/4HANA Cloud Einführung

Qualifikationen:
• Fundierte Kenntnisse in SAP BTP, SAP Integration Suite, SAP HANA
• Erfahrung mit CAP (Cloud Application Programming Model)
• JavaScript/TypeScript, Node.js, REST APIs
• SAP-Zertifizierungen von Vorteil

Unser Angebot:
• Arbeiten in einem innovativen, internationalen Team
• Remote-Arbeit zu 80% möglich
• Wettbewerbsfähiges Gehalt + Benefits

Wien, Österreich | Vollzeit | Start: ab sofort`,
        city:                 'Vienna',
        country:              'Austria',
        company_url:          'https://www.cloudhero.at',
        company_linkedin_url: 'https://www.linkedin.com/company/cloudhero-at',
        company_name:         'CloudHero Solutions GmbH',
        job_poster_url:       null,
        source:               'LinkedIn jobs',
        applicant_count:      '8 applicants',
        search_term:          'SAP BTP Architect',
    },
];

async function main() {
    const db = Database.getInstance();
    await db.connect();
    const svc = new DatabaseService();

    console.log('');
    console.log(chalk.bold('  claude-jpe — Seed Test Jobs'));
    console.log('  ─────────────────────────────────────────────');
    console.log('');

    const inserted = [];
    for (const job of JOBS) {
        try {
            const result = await svc.upsertJob(job);
            const id = result?.id ?? '?';
            inserted.push({ id, title: job.job_title, company: job.company_name });
            console.log(`  ${chalk.green('✓')} Job #${id}  ${chalk.cyan(job.company_name)} — ${job.job_title.slice(0, 50)}`);
        } catch (err) {
            console.log(`  ${chalk.red('✗')} Failed to insert "${job.job_title}": ${err.message}`);
        }
    }

    console.log('');
    console.log(`  ${chalk.bold(inserted.length)} jobs inserted.`);
    console.log('');
    console.log(chalk.dim('  Next steps:'));
    console.log(chalk.dim('    npm run pipeline   — process these jobs through all 8 stages'));
    console.log(chalk.dim('    npm run status     — check job + contact counts'));
    console.log(chalk.dim('    npm run logs       — watch stage-by-stage output'));
    console.log(chalk.dim('    npm start          — open http://localhost:3000 for UI'));
    console.log('');
    process.exit(0);
}

main().catch(err => {
    console.error(chalk.red('  Seed failed: ' + err.message));
    process.exit(1);
});
