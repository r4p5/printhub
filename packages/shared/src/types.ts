export type ColorMode = 'bw' | 'color';
export type Orientation = 'auto' | 'portrait' | 'landscape';
export type Sides = 'single' | 'double';
export type DuplexBinding = 'long' | 'short';
export type PagesPerSheet = 1 | 2 | 4 | 6 | 9;
export type Rotation = 'auto' | 0 | 90 | 180 | 270;

export interface PrintOptions {
  color: ColorMode;
  orientation: Orientation;
  sides: Sides;
  binding: DuplexBinding;
  pagesPerSheet: PagesPerSheet;
  /** Clockwise rotation applied to every page. */
  rotation: Rotation;
  /** '' means all pages, otherwise e.g. "1-3,5,8-". */
  pageRange: string;
  copies: number;
}

/** All money values are integer paise to avoid floating point drift. */
export interface Pricing {
  bwPerSide: number;
  colorPerSide: number;
  /** Optional per-side price when printing double-sided; falls back to the single-sided price. */
  bwDuplexPerSide: number | null;
  colorDuplexPerSide: number | null;
  minimumOrder: number;
  maxCopies: number;
}

/** What the customer is allowed to choose, derived from enabled printers. */
export interface Capabilities {
  color: boolean;
  duplex: boolean;
}

export type JobState =
  | 'uploaded'
  | 'awaiting_payment'
  | 'payment_pending'
  | 'payment_verified'
  | 'queued'
  | 'processing'
  | 'printing'
  | 'completed'
  | 'failed'
  | 'manual_review'
  | 'cancelled';

export type DocumentKind = 'pdf' | 'jpg' | 'png';

export interface PageSize {
  w: number;
  h: number;
}

export interface DocumentEstimate {
  pages: number;
  sidesPerCopy: number;
  sheetsPerCopy: number;
  copies: number;
  color: ColorMode;
  sides: Sides;
  amount: number;
}

export interface OrderEstimate {
  documents: DocumentEstimate[];
  totalPages: number;
  totalSheets: number;
  subtotal: number;
  total: number;
  minimumApplied: boolean;
}
