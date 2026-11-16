export * from './types.ts';
export * from './options.ts';
export * from './pageRange.ts';
export * from './layout.ts';
export * from './pricing.ts';

export const MOBILE_RE = /^[6-9]\d{9}$/;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_JOB = 20;
export const MAX_PAGES = 1000;
export const ACCEPTED_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;
