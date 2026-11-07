/**
 * The category enum and the validator that holds a model to it.
 *
 * Two corrections from `phase-6-hardening.md` section 3 shape this file.
 *
 * First, category assignment is **not deterministic**. It is model-assigned
 * against a fixed enum, which prevents novel labels but does not make the
 * result reproducible. Calling it deterministic overstated what we can promise,
 * so every assignment records `classifierVersion`, `promptVersion`,
 * `confidence`, and `validationStatus` and can be audited later.
 *
 * Second, `uncategorized` is a first-class value rather than a failure. The
 * original exit condition — every workflow has exactly one category — rewards
 * fabrication, because a model asked to always choose will always choose. A
 * page that cannot be categorised honestly says so.
 *
 * Nothing here calls a model. This is the shape a model's answer must fit.
 */

/** Bump when the enum, the subcategories, or the validation rules change. */
export const CLASSIFIER_VERSION = 'taxonomy-1';

export const TAXONOMY = {
  'ai-and-agents': ['agents', 'rag-and-document-qa', 'content-generation', 'vision-and-ocr'],
  'sales-marketing-growth': [
    'lead-gen-and-enrichment',
    'social-publishing',
    'email-outreach',
    'seo-and-content',
  ],
  'support-and-communication': [
    'email-triage',
    'chatbots',
    'tickets-and-incidents',
    'feedback-and-surveys',
  ],
  'operations-and-finance': [
    'invoicing',
    'ecommerce-fulfilment',
    'hr-onboarding',
    'approvals',
  ],
  'data-and-sync': [
    'spreadsheet-database-sync',
    'scraping-and-monitoring',
    'reporting',
    'form-intake',
  ],
  'devops-and-security': ['ci-cd', 'infrastructure-monitoring', 'compliance', 'backup'],
  'personal-productivity': ['notes-and-second-brain', 'calendar-and-tasks', 'home-and-iot'],
} as const satisfies Record<string, readonly string[]>;

export type CategoryDomain = keyof typeof TAXONOMY;

/** Every valid domain, sorted, so prompts and output are stable across runs. */
export const CATEGORY_DOMAINS = Object.keys(TAXONOMY).sort() as CategoryDomain[];

/**
 * Expected shares from `phase-6-content-depth.md` section 3.
 *
 * These are a **monitoring signal, not a constraint**. A classifier whose
 * output diverges wildly from them is worth investigating before publishing a
 * cohort; one that matches them exactly because it was told to would be worse
 * than useless. Never used to reassign an entry.
 */
export const EXPECTED_SHARE: Record<CategoryDomain, [number, number]> = {
  'ai-and-agents': [0.25, 0.3],
  'sales-marketing-growth': [0.2, 0.25],
  'support-and-communication': [0.15, 0.2],
  'operations-and-finance': [0.1, 0.15],
  'data-and-sync': [0.1, 0.15],
  'devops-and-security': [0.05, 0.1],
  'personal-productivity': [0.03, 0.05],
};

export type ValidationStatus = 'VALID' | 'UNKNOWN_DOMAIN' | 'UNKNOWN_SUBCATEGORY' | 'MALFORMED' | 'LOW_CONFIDENCE';

export type Classification = {
  /** `null` means uncategorized, which is an honest answer rather than a failure. */
  domain: CategoryDomain | null;
  subcategory: string | null;
  confidence: number;
  classifierVersion: string;
  promptVersion: string;
  validationStatus: ValidationStatus;
};

/** Below this, an assignment is recorded but not treated as categorised. */
export const MIN_CONFIDENCE = 0.55;

function uncategorized(
  status: ValidationStatus,
  promptVersion: string,
  confidence = 0,
): Classification {
  return {
    domain: null,
    subcategory: null,
    confidence,
    classifierVersion: CLASSIFIER_VERSION,
    promptVersion,
    validationStatus: status,
  };
}

export function isCategoryDomain(value: unknown): value is CategoryDomain {
  return typeof value === 'string' && Object.hasOwn(TAXONOMY, value);
}

/**
 * Validates one model answer against the enum.
 *
 * Never throws and never invents a category. Anything it cannot confirm becomes
 * `uncategorized` with the reason recorded, so a cohort's failure modes are
 * countable afterwards instead of being flattened into one number.
 */
export function validateClassification(raw: unknown, promptVersion: string): Classification {
  if (!raw || typeof raw !== 'object') return uncategorized('MALFORMED', promptVersion);

  const record = raw as Record<string, unknown>;
  const confidence =
    typeof record.confidence === 'number' && Number.isFinite(record.confidence)
      ? Math.min(1, Math.max(0, record.confidence))
      : 0;

  if (!isCategoryDomain(record.domain)) {
    return uncategorized('UNKNOWN_DOMAIN', promptVersion, confidence);
  }

  const allowed = TAXONOMY[record.domain] as readonly string[];
  if (typeof record.subcategory !== 'string' || !allowed.includes(record.subcategory)) {
    return uncategorized('UNKNOWN_SUBCATEGORY', promptVersion, confidence);
  }

  if (confidence < MIN_CONFIDENCE) {
    return uncategorized('LOW_CONFIDENCE', promptVersion, confidence);
  }

  return {
    domain: record.domain,
    subcategory: record.subcategory,
    confidence,
    classifierVersion: CLASSIFIER_VERSION,
    promptVersion,
    validationStatus: 'VALID',
  };
}

/** Counts each outcome in a cohort, for the canary's abort thresholds. */
export function summarizeClassifications(
  classifications: ReadonlyArray<Classification>,
): { total: number; categorized: number; uncategorizedRate: number; byStatus: Record<string, number> } {
  const byStatus: Record<string, number> = {};
  let categorized = 0;
  for (const item of classifications) {
    byStatus[item.validationStatus] = (byStatus[item.validationStatus] ?? 0) + 1;
    if (item.domain !== null) categorized += 1;
  }
  const total = classifications.length;
  return {
    total,
    categorized,
    uncategorizedRate: total === 0 ? 0 : (total - categorized) / total,
    byStatus,
  };
}
