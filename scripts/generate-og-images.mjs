import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The footer identity baked into every generated OG image.
 *
 * An image is a published artifact: baking a hardcoded host into it asserts an
 * origin nobody configured, and the parity gate cannot see inside a PNG. So the
 * footer carries the configured `https:` origin when there is one and the site
 * name otherwise. `page-meta.ts` is read as text because this is a plain `.mjs`
 * script with no transpile step.
 */
const SITE_NAME = /export const SITE_NAME = '([^']+)'/.exec(
  fs.readFileSync(path.join(ROOT, 'app', 'src', 'seo', 'page-meta.ts'), 'utf8'),
)?.[1] ?? 'n8n-secureflow';

export function footerLabel(raw = process.env.NEXT_PUBLIC_SITE_URL) {
  const value = (raw ?? '').trim();
  if (value) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
        return url.href.replace(/\/$/, '');
      }
    } catch {
      // Not a URL: fall through to the site name rather than publish it.
    }
  }
  return SITE_NAME;
}


function getOutDirs() {
  const dirs = [path.join(ROOT, 'app', 'public', 'og'), path.join(ROOT, 'public', 'og')];
  return Array.from(new Set(dirs.filter((d) => fs.existsSync(path.dirname(path.dirname(d))))));
}

const INTEGRATIONS = [
  'generic',
  'openai',
  'google-sheets',
  'slack',
  'telegram',
  'postgres',
  'supabase',
  'github',
  'gmail',
  'google-drive',
  'notion',
  'airtable',
  'hubspot',
  'stripe',
  'discord',
  'whatsapp',
  'anthropic',
  'gemini',
  'openrouter',
  'aws',
  's3',
  'redis',
  'mysql',
  'mongodb',
  'nocodb',
  'baserow',
  'jira',
  'shopify',
  'wordpress',
  'twitter',
  'facebook',
  'linkedin',
  'outlook',
  'google-docs',
  'google-calendar',
  'youtube',
  'spotify',
  'pipedrive',
  'twilio',
  'rss',
  'mattermost',
  'graphql',
  'email',
  'http',
  'webhook',
  'schedule',
  'code',
  'agent',
  'rag',
  'database',
  'mcp',
  'zendesk',
  'linear',
  'trello',
  'clickup',
  'asana',
  'salesforce',
  'intercom',
  'mailchimp',
  'sendgrid',
];

const GRADES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const GRADE_STYLES = {
  LOW: {
    bg: '#064e3b',
    border: '#047857',
    text: '#10b981',
    label: 'GRADE: LOW RISK',
  },
  MEDIUM: {
    bg: '#7c2d12',
    border: '#c2410c',
    text: '#f97316',
    label: 'GRADE: MEDIUM RISK',
  },
  HIGH: {
    bg: '#7f1d1d',
    border: '#b91c1c',
    text: '#ef4444',
    label: 'GRADE: HIGH RISK',
  },
  CRITICAL: {
    bg: '#450a0a',
    border: '#991b1b',
    text: '#f87171',
    label: 'GRADE: CRITICAL RISK',
  },
};

function capitalize(s) {
  if (!s) return 'n8n';
  return s
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function generateSvg(integration, grade) {
  const intName = capitalize(integration);
  const style = GRADE_STYLES[grade] || GRADE_STYLES.LOW;
  const footer = footerLabel();

  return `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="1200" height="630" fill="#0b0f19"/>

  <!-- Outer Hairline Frame -->
  <rect x="24" y="24" width="1152" height="582" rx="16" fill="#111827" stroke="#1f2937" stroke-width="2"/>
  <rect x="48" y="48" width="1104" height="534" rx="12" fill="none" stroke="#374151" stroke-width="1" stroke-dasharray="6 6"/>

  <!-- Top Accent Bar -->
  <rect x="48" y="48" width="1104" height="4" fill="#38bdf8"/>

  <!-- Header / Badge -->
  <text x="80" y="120" font-family="Inter, system-ui, sans-serif" font-size="20" font-weight="600" fill="#38bdf8" letter-spacing="2">N8N COMMUNITY HUB</text>
  <text x="80" y="150" font-family="Inter, system-ui, sans-serif" font-size="16" fill="#9ca3af">Static Analysis &amp; Security Index</text>

  <!-- Integration Title -->
  <text x="80" y="270" font-family="Outfit, Inter, system-ui, sans-serif" font-size="56" font-weight="700" fill="#f9fafb">${intName} Workflows</text>
  <text x="80" y="320" font-family="Inter, system-ui, sans-serif" font-size="24" fill="#9ca3af">Automated templates, node graph structures &amp; taint policy verification</text>

  <!-- Security Grade Badge -->
  <g transform="translate(80, 370)">
    <rect width="280" height="60" rx="8" fill="${style.bg}" stroke="${style.border}" stroke-width="2"/>
    <text x="140" y="38" font-family="JetBrains Mono, monospace" font-size="20" font-weight="700" fill="${style.text}" text-anchor="middle">${style.label}</text>
  </g>

  <!-- Node count is intentionally a range because cards are shared by integration and grade. -->
  <g transform="translate(380, 370)">
    <rect width="360" height="60" rx="8" fill="#1f2937" stroke="#374151" stroke-width="1"/>
    <text x="180" y="38" font-family="JetBrains Mono, monospace" font-size="18" fill="#e5e7eb" text-anchor="middle">NODE COUNT: 12+</text>
  </g>

  <!-- Footer Info -->
  <line x1="80" y1="500" x2="1120" y2="500" stroke="#1f2937" stroke-width="1"/>
  <text x="80" y="540" font-family="JetBrains Mono, monospace" font-size="16" fill="#6b7280">${footer}</text>
  <text x="1120" y="540" font-family="JetBrains Mono, monospace" font-size="16" fill="#6b7280" text-anchor="end">STATIC EXPORT v1.0</text>
</svg>`;
}

async function main() {
  const footer = footerLabel();
  console.log(`Generating OG images... footer: ${footer}`);
  let totalCount = 0;
  let maxSize = 0;
  const outDirs = getOutDirs();

  for (const dir of outDirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  for (const integration of INTEGRATIONS) {
    for (const grade of GRADES) {
      const svg = generateSvg(integration, grade);
      const fileName = `og-${integration}-${grade}.png`;

      const buf = await sharp(Buffer.from(svg))
        .png({ compressionLevel: 9 })
        .toBuffer();

      for (const dir of outDirs) {
        fs.writeFileSync(path.join(dir, fileName), buf);
      }

      totalCount++;
      if (buf.length > maxSize) {
        maxSize = buf.length;
      }
    }
  }

  console.log(`[SEO-7] Generated ${totalCount} OG images. Max size: ${(maxSize / 1024).toFixed(2)} KB.`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('Failed to generate OG images:', err);
    process.exit(1);
  });
}