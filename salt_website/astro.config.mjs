import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  // Canonical production URL. Required for Starlight to emit sitemap.xml.
  site: 'https://surveysalt.com',
  integrations: [
    starlight({
      title: 'SALT',
      description: 'System Assisted Link Tracing — continuous, facility-based link-tracing surveys for monitoring key populations in HIV response programs.',
      logo: {
        src: './src/assets/salt_logo.png',
        replacesTitle: true,
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/cdcgov/salt' },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'What is SALT?', slug: 'getting-started/what-is-salt' },
            { label: 'Statistical Validity', slug: 'getting-started/statistical-validity' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Docker Deployment', slug: 'getting-started/docker-deployment' },
            { label: 'First Steps', slug: 'getting-started/first-steps' },
          ],
        },
        {
          label: 'Management Dashboard',
          collapsed: false,
          items: [
            { label: 'Dashboard Overview', slug: 'management/dashboard' },
            { label: 'Facilities', slug: 'management/facilities' },
            { label: 'Uploads', slug: 'management/uploads' },
            { label: 'Surveys', slug: 'management/surveys' },
            { label: 'Survey Questions', slug: 'management/survey-questions' },
            { label: 'Survey Logic', slug: 'management/survey-logic' },
            { label: 'System Messages', slug: 'management/system-messages' },
            { label: 'Rapid Tests', slug: 'management/rapid-tests' },
            { label: 'Languages', slug: 'management/languages' },
            { label: 'Eligibility', slug: 'management/eligibility' },
            { label: 'Import & Export Surveys', slug: 'management/import-export' },
            { label: 'Users', slug: 'management/users' },
            { label: 'Lab Tests', slug: 'management/lab-tests' },
            { label: 'Reports', slug: 'management/reports' },
            { label: 'AI Assistant (MCP)', slug: 'management/ai-report-builder' },
            { label: 'Export Data', slug: 'management/export-data' },
            { label: 'Edit Data', slug: 'management/edit-data' },
            { label: 'System', slug: 'management/system' },
          ],
        },
        {
          label: 'Tablet App',
          collapsed: false,
          items: [
            { label: 'Tablet Setup', slug: 'tablet/setup' },
            { label: 'Conducting a Survey', slug: 'tablet/staff-survey' },
            { label: 'Recruitment & Payment', slug: 'tablet/staff-recruitment' },
            { label: 'Administrator Guide', slug: 'tablet/admin-guide' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Glossary', slug: 'reference/glossary' },
            { label: 'Troubleshooting', slug: 'reference/troubleshooting' },
            { label: 'Source Code', slug: 'reference/source-code' },
          ],
        },
      ],
      tableOfContents: false,
      customCss: ['./src/styles/custom.css'],
      components: {
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
    }),
  ],
});
